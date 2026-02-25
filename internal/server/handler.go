package server

import (
	"embed"
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"github.com/flatcoke/prview/internal/git"
	"github.com/flatcoke/prview/internal/watcher"
)

// wsDebounceDuration is the debounce window for file-change events sent over WebSocket.
const wsDebounceDuration = 300 * time.Millisecond

// contentTypeJSON is the MIME type for JSON responses.
const contentTypeJSON = "application/json"

// Diff modes used by the /api/diff endpoint and the frontend.
const (
	diffModeBranch      = "branch"
	diffModeUncommitted = "uncommitted"
)

//go:embed static/*
var staticFS embed.FS

// Config holds server configuration.
type Config struct {
	Port      int
	Staged    bool
	All       bool
	RefArgs   []string
	WorkDir   string // The directory prview was launched in
	Workspace bool   // True if workspace mode (multiple repos)
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// srv holds the shared state for all HTTP handlers.
type srv struct {
	cfg         Config
	hiddenRepos map[string]bool
	watchMgr    *watcher.Manager
}

// New creates and returns a configured http.Handler.
func New(cfg Config) http.Handler {
	s := &srv{
		cfg:         cfg,
		hiddenRepos: make(map[string]bool),
		watchMgr:    watcher.NewManager(),
	}

	mux := http.NewServeMux()

	// Serve static files with SPA fallback for all non-API routes.
	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		log.Fatalf("failed to create sub filesystem: %v", err)
	}
	staticHandler := http.FileServer(http.FS(sub))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if path == "/" || path == "/index.html" ||
			path == "/app.js" || path == "/style.css" {
			staticHandler.ServeHTTP(w, r)
			return
		}
		// SPA fallback for /repos/* and any other non-file routes.
		if strings.HasPrefix(path, "/repos/") || !strings.Contains(path, ".") {
			r.URL.Path = "/"
			staticHandler.ServeHTTP(w, r)
			return
		}
		staticHandler.ServeHTTP(w, r)
	})

	mux.HandleFunc("/api/branches", s.handleBranches)
	mux.HandleFunc("/api/worktrees", s.handleWorktrees)
	mux.HandleFunc("/api/clear", s.handleClear)
	mux.HandleFunc("/api/hide", s.handleHide)
	mux.HandleFunc("/api/repos", s.handleRepos)
	mux.HandleFunc("/api/diff", s.handleDiff)
	mux.HandleFunc("/ws", s.handleWS)

	return mux
}

// writeJSON writes v as JSON to w, setting the Content-Type header.
func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", contentTypeJSON)
	json.NewEncoder(w).Encode(v)
}

// writeError writes a JSON {"error":"..."} response with the given status code.
func writeError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", contentTypeJSON)
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// handleBranches serves GET /api/branches (list) and DELETE /api/branches (remove).
func (s *srv) handleBranches(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodDelete {
		s.handleDeleteBranch(w, r)
		return
	}

	repoName := r.URL.Query().Get("repo")
	var repoDir string
	if repoName != "" {
		dir, ok := safeRepoPath(s.cfg.WorkDir, repoName)
		if !ok {
			writeError(w, "invalid repo name", http.StatusBadRequest)
			return
		}
		if !git.IsGitRepo(dir) {
			writeError(w, "not a git repository", http.StatusNotFound)
			return
		}
		repoDir = dir
	}

	branches, err := git.ListBranches(repoDir)
	if err != nil {
		writeError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]interface{}{
		"branches": branches,
		"default":  git.DefaultBranch(repoDir),
		"current":  git.CurrentBranch(repoDir),
	})
}

// handleWorktrees serves GET /api/worktrees (list) and DELETE /api/worktrees (remove).
func (s *srv) handleWorktrees(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodDelete {
		s.handleDeleteWorktree(w, r)
		return
	}

	repoName := r.URL.Query().Get("repo")
	if repoName == "" {
		writeError(w, "repo parameter required", http.StatusBadRequest)
		return
	}
	repoDir, ok := safeRepoPath(s.cfg.WorkDir, repoName)
	if !ok {
		writeError(w, "invalid repo name", http.StatusBadRequest)
		return
	}
	if !git.IsGitRepo(repoDir) {
		writeError(w, "not a git repository", http.StatusNotFound)
		return
	}

	worktrees, err := git.GitWorktrees(repoDir)
	if err != nil {
		writeError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]interface{}{"worktrees": worktrees})
}

// handleClear serves POST /api/clear — runs git checkout . + git clean -fd.
func (s *srv) handleClear(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	repoName := r.URL.Query().Get("repo")
	if repoName == "" {
		writeError(w, "repo parameter required", http.StatusBadRequest)
		return
	}
	repoDir, ok := safeRepoPath(s.cfg.WorkDir, repoName)
	if !ok {
		writeError(w, "invalid repo name", http.StatusBadRequest)
		return
	}
	if err := git.ClearRepo(repoDir); err != nil {
		writeError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]string{"ok": "cleared"})
}

// handleHide serves POST /api/hide (hide repo) and DELETE /api/hide (unhide repo).
func (s *srv) handleHide(w http.ResponseWriter, r *http.Request) {
	repoName := r.URL.Query().Get("repo")
	if repoName == "" {
		writeError(w, "repo parameter required", http.StatusBadRequest)
		return
	}
	switch r.Method {
	case http.MethodPost:
		s.hiddenRepos[repoName] = true
		writeJSON(w, map[string]string{"ok": "hidden"})
	case http.MethodDelete:
		delete(s.hiddenRepos, repoName)
		writeJSON(w, map[string]string{"ok": "unhidden"})
	default:
		writeError(w, "POST or DELETE required", http.StatusMethodNotAllowed)
	}
}

// handleRepos serves GET /api/repos — lists discovered repos in workspace mode.
func (s *srv) handleRepos(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.Workspace {
		writeJSON(w, map[string]interface{}{"workspace": false, "repos": []interface{}{}})
		return
	}

	repos, err := git.DiscoverRepos(s.cfg.WorkDir)
	if err != nil {
		writeError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Filter out hidden repos unless ?all=true.
	if r.URL.Query().Get("all") != "true" && len(s.hiddenRepos) > 0 {
		filtered := make([]git.Repo, 0, len(repos))
		for _, repo := range repos {
			if !s.hiddenRepos[repo.Name] {
				filtered = append(filtered, repo)
			}
		}
		repos = filtered
	}

	writeJSON(w, map[string]interface{}{
		"workspace": true,
		"repos":     repos,
		"hidden":    len(s.hiddenRepos),
	})
}

// handleDiff serves GET /api/diff.
func (s *srv) handleDiff(w http.ResponseWriter, r *http.Request) {
	repoName := r.URL.Query().Get("repo")

	if s.cfg.Workspace && repoName != "" {
		repoDir, ok := safeRepoPath(s.cfg.WorkDir, repoName)
		if !ok {
			writeError(w, "invalid repo name", http.StatusBadRequest)
			return
		}
		if !git.IsGitRepo(repoDir) {
			writeError(w, "not a git repository", http.StatusNotFound)
			return
		}

		diffDir := repoDir
		if worktreeName := r.URL.Query().Get("worktree"); worktreeName != "" {
			worktrees, err := git.GitWorktrees(repoDir)
			if err != nil {
				writeError(w, err.Error(), http.StatusInternalServerError)
				return
			}
			found := false
			for _, wt := range worktrees {
				if wt.Name == worktreeName {
					diffDir = wt.Path
					found = true
					break
				}
			}
			if !found {
				writeError(w, "worktree not found", http.StatusNotFound)
				return
			}
		}

		args := buildDiffArgs(s.cfg, r, diffDir)
		result, err := git.DiffInRepo(diffDir, args)
		if err != nil {
			writeError(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, result)
		return
	}

	// Single repo mode.
	args := buildDiffArgs(s.cfg, r, "")
	result, err := git.Diff(args)
	if err != nil {
		writeError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, result)
}

// handleWS serves the WebSocket endpoint for real-time diff refresh.
func (s *srv) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade: %v", err)
		return
	}

	watchDir, ok := resolveWatchDir(s.cfg, r)
	if !ok {
		_ = conn.WriteJSON(map[string]string{"type": "error", "message": "invalid repo"})
		conn.Close()
		return
	}

	// Subscribe to the shared watcher for this directory. Multiple WS
	// connections to the same repo share one fsnotify watcher, preventing
	// file-descriptor exhaustion when browsers rapidly reconnect.
	refreshCh, unsub, err := s.watchMgr.Subscribe(watchDir, wsDebounceDuration)
	if err != nil {
		log.Printf("ws watcher: %v", err)
		_ = conn.WriteJSON(map[string]string{"type": "error", "message": "watcher failed"})
		conn.Close()
		return
	}
	defer unsub()
	defer conn.Close()

	// readErr receives an error the moment the client disconnects or sends
	// invalid data. gorilla/websocket allows one concurrent reader and one
	// concurrent writer — the reader lives in this goroutine, all writes
	// happen in the select loop below, ensuring serialised access.
	readErr := make(chan error, 1)
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				readErr <- err
				return
			}
		}
	}()

	// Main loop: ONLY this goroutine writes to conn.
	for {
		select {
		case <-refreshCh:
			if err := conn.WriteJSON(map[string]string{"type": "refresh"}); err != nil {
				return
			}
		case <-readErr:
			return
		case <-r.Context().Done():
			return
		}
	}
}

// handleDeleteBranch handles DELETE /api/branches?repo=X&branch=Y[&force=true].
func (s *srv) handleDeleteBranch(w http.ResponseWriter, r *http.Request) {
	branchName := r.URL.Query().Get("branch")
	if branchName == "" {
		writeError(w, "branch parameter required", http.StatusBadRequest)
		return
	}
	var repoDir string
	if repoName := r.URL.Query().Get("repo"); repoName != "" {
		dir, ok := safeRepoPath(s.cfg.WorkDir, repoName)
		if !ok {
			writeError(w, "invalid repo name", http.StatusBadRequest)
			return
		}
		repoDir = dir
	}
	force := r.URL.Query().Get("force") == "true"
	if err := git.DeleteBranch(repoDir, branchName, force); err != nil {
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, map[string]string{"ok": "deleted"})
}

// handleDeleteWorktree handles DELETE /api/worktrees?repo=X&worktree=Y.
func (s *srv) handleDeleteWorktree(w http.ResponseWriter, r *http.Request) {
	repoName := r.URL.Query().Get("repo")
	worktreeName := r.URL.Query().Get("worktree")
	if repoName == "" || worktreeName == "" {
		writeError(w, "repo and worktree parameters required", http.StatusBadRequest)
		return
	}
	repoDir, ok := safeRepoPath(s.cfg.WorkDir, repoName)
	if !ok {
		writeError(w, "invalid repo name", http.StatusBadRequest)
		return
	}
	if err := git.DeleteWorktree(repoDir, worktreeName); err != nil {
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, map[string]string{"ok": "removed"})
}

// buildDiffArgs builds git diff arguments based on config, request params, and repo dir.
// repoDir is empty in single-repo mode (git runs in CWD).
func buildDiffArgs(cfg Config, r *http.Request, repoDir string) []string {
	// CLI launch-time overrides take priority.
	if len(cfg.RefArgs) > 0 {
		return cfg.RefArgs
	}
	if cfg.Staged {
		return []string{"--cached"}
	}
	if cfg.All {
		return []string{"HEAD"}
	}

	mode := r.URL.Query().Get("mode")
	if mode == "" {
		mode = diffModeBranch
	}

	switch mode {
	case diffModeUncommitted:
		if r.URL.Query().Get("staged") == "true" {
			return []string{"--cached"}
		}
		if ref := r.URL.Query().Get("ref"); ref != "" {
			return []string{ref}
		}
		return nil // plain git diff
	default: // diffModeBranch
		base := r.URL.Query().Get("base")
		if base == "" {
			base = git.DefaultBranch(repoDir)
		}
		return []string{base + "...HEAD"}
	}
}

// safeRepoPath validates a repo name and returns the absolute path within workDir.
// Repo names may contain "/" for nested repos (e.g. "meta/web") but must not
// contain ".." components or empty segments to prevent directory traversal.
func safeRepoPath(workDir, repoName string) (string, bool) {
	for _, part := range strings.Split(repoName, "/") {
		if part == "" || part == "." || part == ".." {
			return "", false
		}
	}
	repoDir := filepath.Join(workDir, filepath.FromSlash(repoName))
	// Confirm the resolved path is still inside workDir.
	base := filepath.Clean(workDir) + string(filepath.Separator)
	if !strings.HasPrefix(filepath.Clean(repoDir)+string(filepath.Separator), base) {
		return "", false
	}
	return repoDir, true
}

// resolveWatchDir returns the filesystem directory to watch for a WebSocket
// connection, based on the repo and worktree query parameters.
func resolveWatchDir(cfg Config, r *http.Request) (string, bool) {
	repoName := r.URL.Query().Get("repo")
	if repoName == "" {
		// Single-repo mode: watch the working directory.
		return cfg.WorkDir, true
	}

	repoDir, ok := safeRepoPath(cfg.WorkDir, repoName)
	if !ok {
		return "", false
	}
	if !git.IsGitRepo(repoDir) {
		return "", false
	}

	worktreeName := r.URL.Query().Get("worktree")
	if worktreeName == "" {
		return repoDir, true
	}

	worktrees, err := git.GitWorktrees(repoDir)
	if err != nil {
		return "", false
	}
	for _, wt := range worktrees {
		if wt.Name == worktreeName {
			return wt.Path, true
		}
	}
	return "", false
}
