package server

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
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

// New creates and returns a configured http.ServeMux.
func New(cfg Config) http.Handler {
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

	// Branches API endpoint.
	mux.HandleFunc("/api/branches", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		repoName := r.URL.Query().Get("repo")
		if repoName != "" {
			repoDir, ok := safeRepoPath(cfg.WorkDir, repoName)
			if !ok {
				http.Error(w, `{"error": "invalid repo name"}`, http.StatusBadRequest)
				return
			}
			if !git.IsGitRepo(repoDir) {
				http.Error(w, `{"error": "not a git repository"}`, http.StatusNotFound)
				return
			}
			branches, err := git.ListBranches(repoDir)
			if err != nil {
				http.Error(w, fmt.Sprintf(`{"error": %q}`, err.Error()), http.StatusInternalServerError)
				return
			}
			json.NewEncoder(w).Encode(map[string]interface{}{
				"branches": branches,
				"default":  git.DefaultBranch(repoDir),
			})
			return
		}
		// Single-repo mode.
		branches, err := git.ListBranches("")
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error": %q}`, err.Error()), http.StatusInternalServerError)
			return
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"branches": branches,
			"default":  git.DefaultBranch(""),
		})
	})

	// Worktrees API endpoint.
	mux.HandleFunc("/api/worktrees", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		repoName := r.URL.Query().Get("repo")
		if repoName == "" {
			http.Error(w, `{"error": "repo parameter required"}`, http.StatusBadRequest)
			return
		}
		repoDir, ok := safeRepoPath(cfg.WorkDir, repoName)
		if !ok {
			http.Error(w, `{"error": "invalid repo name"}`, http.StatusBadRequest)
			return
		}
		if !git.IsGitRepo(repoDir) {
			http.Error(w, `{"error": "not a git repository"}`, http.StatusNotFound)
			return
		}
		worktrees, err := git.GitWorktrees(repoDir)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error": %q}`, err.Error()), http.StatusInternalServerError)
			return
		}
		json.NewEncoder(w).Encode(map[string]interface{}{"worktrees": worktrees})
	})

	// Workspace mode: list repos.
	mux.HandleFunc("/api/repos", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !cfg.Workspace {
			json.NewEncoder(w).Encode(map[string]interface{}{"workspace": false, "repos": []interface{}{}})
			return
		}
		repos, err := git.DiscoverRepos(cfg.WorkDir)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error": %q}`, err.Error()), http.StatusInternalServerError)
			return
		}
		json.NewEncoder(w).Encode(map[string]interface{}{"workspace": true, "repos": repos})
	})

	// Diff API endpoint.
	mux.HandleFunc("/api/diff", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		repoName := r.URL.Query().Get("repo")

		if cfg.Workspace && repoName != "" {
			repoDir, ok := safeRepoPath(cfg.WorkDir, repoName)
			if !ok {
				http.Error(w, `{"error": "invalid repo name"}`, http.StatusBadRequest)
				return
			}
			if !git.IsGitRepo(repoDir) {
				http.Error(w, `{"error": "not a git repository"}`, http.StatusNotFound)
				return
			}

			diffDir := repoDir
			if worktreeName := r.URL.Query().Get("worktree"); worktreeName != "" {
				worktrees, err := git.GitWorktrees(repoDir)
				if err != nil {
					http.Error(w, fmt.Sprintf(`{"error": %q}`, err.Error()), http.StatusInternalServerError)
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
					http.Error(w, `{"error": "worktree not found"}`, http.StatusNotFound)
					return
				}
			}

			args := buildDiffArgs(cfg, r, diffDir)
			result, err := git.DiffInRepo(diffDir, args)
			if err != nil {
				http.Error(w, fmt.Sprintf(`{"error": %q}`, err.Error()), http.StatusInternalServerError)
				return
			}
			json.NewEncoder(w).Encode(result)
			return
		}

		// Single repo mode.
		args := buildDiffArgs(cfg, r, "")
		result, err := git.Diff(args)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error": %q}`, err.Error()), http.StatusInternalServerError)
			return
		}
		json.NewEncoder(w).Encode(result)
	})

	// WebSocket endpoint for real-time diff refresh.
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("ws upgrade: %v", err)
			return
		}

		// Resolve the directory to watch.
		watchDir, ok := resolveWatchDir(cfg, r)
		if !ok {
			_ = conn.WriteJSON(map[string]string{"type": "error", "message": "invalid repo"})
			conn.Close()
			return
		}

		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()

		// refreshCh is buffered so the watcher goroutine never blocks.
		// Capacity 1 provides natural deduplication: at most one refresh queued.
		refreshCh := make(chan struct{}, 1)

		stopWatch, err := watcher.Watch(ctx, watchDir, 300*time.Millisecond, func() {
			select {
			case refreshCh <- struct{}{}:
			default: // a refresh is already pending — drop the duplicate
			}
		})
		if err != nil {
			log.Printf("ws watcher: %v", err)
			_ = conn.WriteJSON(map[string]string{"type": "error", "message": "watcher failed"})
			conn.Close()
			return
		}
		defer stopWatch()

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

		defer conn.Close()

		// Main loop: ONLY this goroutine writes to conn.
		for {
			select {
			case <-refreshCh:
				if err := conn.WriteJSON(map[string]string{"type": "refresh"}); err != nil {
					return
				}
			case <-readErr:
				return
			case <-ctx.Done():
				return
			}
		}
	})

	return mux
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
		mode = "branch"
	}

	switch mode {
	case "uncommitted":
		if r.URL.Query().Get("staged") == "true" {
			return []string{"--cached"}
		}
		if ref := r.URL.Query().Get("ref"); ref != "" {
			return []string{ref}
		}
		return nil // plain git diff
	default: // "branch"
		base := r.URL.Query().Get("base")
		if base == "" {
			base = git.DefaultBranch(repoDir)
		}
		return []string{base + "...HEAD"}
	}
}
