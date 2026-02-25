package server

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/flatcoke/prview/internal/git"
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
			args := buildDiffArgs(cfg, r)
			result, err := git.DiffInRepo(repoDir, args)
			if err != nil {
				http.Error(w, fmt.Sprintf(`{"error": %q}`, err.Error()), http.StatusInternalServerError)
				return
			}
			json.NewEncoder(w).Encode(result)
			return
		}

		// Single repo mode.
		args := buildDiffArgs(cfg, r)
		result, err := git.Diff(args)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error": %q}`, err.Error()), http.StatusInternalServerError)
			return
		}
		json.NewEncoder(w).Encode(result)
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

func buildDiffArgs(cfg Config, r *http.Request) []string {
	var args []string

	staged := cfg.Staged || r.URL.Query().Get("staged") == "true"
	all := cfg.All || r.URL.Query().Get("all") == "true"

	if ref := r.URL.Query().Get("ref"); ref != "" {
		args = append(args, ref)
	} else if len(cfg.RefArgs) > 0 {
		args = append(args, cfg.RefArgs...)
	} else if all {
		args = append(args, "HEAD")
	} else if staged {
		args = append(args, "--cached")
	}

	return args
}
