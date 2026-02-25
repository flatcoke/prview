package watcher

import (
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

// skipDirs is a set of well-known large/generated directory names that are
// always excluded from recursive watching, in addition to gitignored paths.
var skipDirs = map[string]bool{
	"node_modules": true,
	".next":        true,
	".nuxt":        true,
	"vendor":       true,
	"dist":         true,
	"build":        true,
	".cache":       true,
	"__pycache__":  true,
}

// gracePeriod is the time to wait before closing a shared watcher after its
// last subscriber disconnects. This handles quick browser refreshes cleanly.
const gracePeriod = 5 * time.Second

// Manager holds a shared fsnotify watcher per watched directory.
// Multiple WebSocket connections to the same directory share one watcher,
// preventing file-descriptor exhaustion on rapid browser refreshes.
type Manager struct {
	mu      sync.Mutex
	entries map[string]*watchEntry
}

type watchEntry struct {
	mu        sync.Mutex
	w         *fsnotify.Watcher
	dir       string
	debounce  time.Duration
	subs      map[int]chan struct{}
	nextID    int
	stopTimer *time.Timer // fires after gracePeriod when no subscribers remain
	closeOnce sync.Once
}

// NewManager creates a new Manager.
func NewManager() *Manager {
	return &Manager{entries: make(map[string]*watchEntry)}
}

// Subscribe registers interest in file-change events for dir.
// The returned channel receives a struct{} after each debounced change.
// The returned cancel func must be called when the subscriber is done (e.g. defer cancel()).
func (m *Manager) Subscribe(dir string, debounce time.Duration) (<-chan struct{}, func(), error) {
	m.mu.Lock()
	entry, ok := m.entries[dir]
	if !ok {
		w, err := fsnotify.NewWatcher()
		if err != nil {
			m.mu.Unlock()
			return nil, nil, err
		}
		// Partial watch is acceptable; errors are logged inside addRecursive.
		addRecursive(w, dir, dir)
		entry = &watchEntry{
			w:        w,
			dir:      dir,
			debounce: debounce,
			subs:     make(map[int]chan struct{}),
		}
		m.entries[dir] = entry
		go entry.run()
	}
	m.mu.Unlock()

	entry.mu.Lock()
	// Cancel any pending close if a new subscriber arrives during grace period.
	if entry.stopTimer != nil {
		entry.stopTimer.Stop()
		entry.stopTimer = nil
	}
	id := entry.nextID
	entry.nextID++
	ch := make(chan struct{}, 1)
	entry.subs[id] = ch
	entry.mu.Unlock()

	return ch, func() { m.unsubscribe(dir, id) }, nil
}

func (m *Manager) unsubscribe(dir string, subID int) {
	m.mu.Lock()
	entry, ok := m.entries[dir]
	m.mu.Unlock()
	if !ok {
		return
	}
	entry.mu.Lock()
	delete(entry.subs, subID)
	if len(entry.subs) == 0 && entry.stopTimer == nil {
		entry.stopTimer = time.AfterFunc(gracePeriod, func() {
			m.removeEntry(dir)
		})
	}
	entry.mu.Unlock()
}

func (m *Manager) removeEntry(dir string) {
	m.mu.Lock()
	entry, ok := m.entries[dir]
	if ok {
		delete(m.entries, dir)
	}
	m.mu.Unlock()
	if ok {
		entry.close()
	}
}

func (e *watchEntry) close() {
	e.closeOnce.Do(func() { e.w.Close() })
}

func (e *watchEntry) run() {
	var (
		mu    sync.Mutex
		timer *time.Timer
	)
	for {
		select {
		case event, ok := <-e.w.Events:
			if !ok {
				return
			}
			if isGitPath(event.Name) {
				continue
			}
			if gitIgnored(e.dir, event.Name) {
				continue
			}
			// If a new directory was created, start watching it too
			// (unless it should be skipped — e.g. a freshly created node_modules).
			if event.Has(fsnotify.Create) {
				if target, err := filepath.EvalSymlinks(event.Name); err == nil {
					if info, err := os.Stat(target); err == nil && info.IsDir() {
						base := filepath.Base(target)
						if !isGitPath(target) && !skipDirs[base] && !gitIgnored(e.dir, target) {
							addRecursive(e.w, target, e.dir)
						}
					}
				}
			}
			mu.Lock()
			if timer != nil {
				timer.Stop()
			}
			timer = time.AfterFunc(e.debounce, func() {
				e.mu.Lock()
				for _, ch := range e.subs {
					select {
					case ch <- struct{}{}:
					default: // a refresh is already pending — drop the duplicate
					}
				}
				e.mu.Unlock()
			})
			mu.Unlock()

		case err, ok := <-e.w.Errors:
			if !ok {
				return
			}
			log.Printf("watcher: debug: %v", err)
		}
	}
}

// addRecursive adds root and all non-ignored subdirectories to the watcher.
// repoDir is passed to git check-ignore so that git's ignore rules apply.
// Failures on individual paths are logged and skipped rather than aborting the walk.
func addRecursive(w *fsnotify.Watcher, root, repoDir string) {
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable entries
		}
		if !d.IsDir() {
			return nil
		}
		if isGitPath(path) {
			return filepath.SkipDir
		}
		if path != root {
			base := filepath.Base(path)
			// Skip well-known large dirs and all hidden dirs (e.g. .cache, .npm).
			if skipDirs[base] || strings.HasPrefix(base, ".") {
				return filepath.SkipDir
			}
			// Skip git-ignored directories (e.g. vendor, dist, bin).
			if gitIgnored(repoDir, path) {
				return filepath.SkipDir
			}
		}
		if err := w.Add(path); err != nil {
			log.Printf("watcher: debug: add %s: %v", path, err)
		}
		return nil
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
