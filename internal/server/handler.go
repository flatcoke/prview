package server

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"

	"github.com/flatcoke/prview/internal/git"
)

//go:embed static/*
var staticFS embed.FS

// Config holds server configuration.
type Config struct {
	Port    int
	Staged  bool
	All     bool
	RefArgs []string
}

// New creates and returns a configured http.ServeMux.
func New(cfg Config) http.Handler {
	mux := http.NewServeMux()

	// Serve static files
	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		log.Fatalf("failed to create sub filesystem: %v", err)
	}
	mux.Handle("/", http.FileServer(http.FS(sub)))

	// API endpoint
	mux.HandleFunc("/api/diff", func(w http.ResponseWriter, r *http.Request) {
		args := buildDiffArgs(cfg, r)
		result, err := git.Diff(args)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error": %q}`, err.Error()), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result)
	})

	return mux
}

func buildDiffArgs(cfg Config, r *http.Request) []string {
	var args []string

	// Query param overrides
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
