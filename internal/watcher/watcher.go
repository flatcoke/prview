package watcher

import (
	"context"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// Watch monitors dir (recursively) for non-git-ignored file-system changes,
// calling notify after a quiet period of debounce.
//
// .git subtrees and paths matched by .gitignore are always skipped.
// The returned cancel function stops the watcher; it is safe to call more than once.
func Watch(ctx context.Context, dir string, debounce time.Duration, notify func()) (cancel func(), err error) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}

	// Add root and all non-ignored subdirectories to the watcher.
	if err := addRecursive(w, dir, dir); err != nil {
		w.Close()
		return nil, err
	}

	var (
		mu    sync.Mutex
		timer *time.Timer
	)

	cancelOnce := sync.Once{}
	cancelFn := func() {
		cancelOnce.Do(func() {
			w.Close()
			mu.Lock()
			if timer != nil {
				timer.Stop()
			}
			mu.Unlock()
		})
	}

	go func() {
		defer cancelFn()
		for {
			select {
			case <-ctx.Done():
				return

			case event, ok := <-w.Events:
				if !ok {
					return
				}
				if isGitPath(event.Name) {
					continue
				}
				if gitIgnored(dir, event.Name) {
					continue
				}
				// If a new directory was created, start watching it too
				// (unless it is git-ignored — e.g. a freshly created node_modules).
				if event.Has(fsnotify.Create) {
					if target, err := filepath.EvalSymlinks(event.Name); err == nil {
						if info, err := os.Stat(target); err == nil && info.IsDir() {
							if !isGitPath(target) && !gitIgnored(dir, target) {
								_ = addRecursive(w, target, dir)
							}
						}
					}
				}
				mu.Lock()
				if timer != nil {
					timer.Stop()
				}
				timer = time.AfterFunc(debounce, notify)
				mu.Unlock()

			case err, ok := <-w.Errors:
				if !ok {
					return
				}
				log.Printf("watcher: %v", err)
			}
		}
	}()

	return cancelFn, nil
}

// addRecursive adds root and all non-ignored subdirectories to the watcher.
// repoDir is passed to git check-ignore so that git's ignore rules apply.
func addRecursive(w *fsnotify.Watcher, root, repoDir string) error {
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable entries
		}
		if !d.IsDir() {
			return nil
		}
		if isGitPath(path) {
			return filepath.SkipDir
		}
		// Skip hidden directories (e.g. .cache, .npm) except for the root itself.
		if path != root && strings.HasPrefix(filepath.Base(path), ".") {
			return filepath.SkipDir
		}
		// Skip git-ignored directories (e.g. node_modules, vendor, dist, bin).
		if path != root && gitIgnored(repoDir, path) {
			return filepath.SkipDir
		}
		return w.Add(path)
	})
}

// isGitPath reports whether path contains a ".git" component.
func isGitPath(path string) bool {
	clean := filepath.ToSlash(filepath.Clean(path))
	for _, part := range strings.Split(clean, "/") {
		if part == ".git" {
			return true
		}
	}
	return false
}

// gitIgnored reports whether path is ignored by git in the given repo directory.
// Returns false on any error (e.g. git not found, path outside repo).
func gitIgnored(repoDir, path string) bool {
	if repoDir == "" {
		return false
	}
	cmd := exec.Command("git", "-C", repoDir, "check-ignore", "-q", "--", path)
	return cmd.Run() == nil // exit 0 = ignored, 1 = not ignored, 128 = error
}
