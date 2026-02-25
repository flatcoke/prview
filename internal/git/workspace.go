package git

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// Protected branch names that cannot be deleted.
const (
	branchMain   = "main"
	branchMaster = "master"
)

// Worktree represents a git worktree.
type Worktree struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	Branch string `json:"branch"`
	Head   string `json:"head"`
}

// GitWorktrees returns the list of worktrees for a git repository.
func GitWorktrees(repoDir string) ([]Worktree, error) {
	out, err := exec.Command("git", "-C", repoDir, "worktree", "list", "--porcelain").Output()
	if err != nil {
		return nil, fmt.Errorf("git worktree list: %w", err)
	}
	return parseWorktrees(string(out)), nil
}

func parseWorktrees(raw string) []Worktree {
	var worktrees []Worktree
	blocks := strings.Split(strings.TrimSpace(raw), "\n\n")
	for i, block := range blocks {
		block = strings.TrimSpace(block)
		if block == "" {
			continue
		}
		var wt Worktree
		for _, line := range strings.Split(block, "\n") {
			switch {
			case strings.HasPrefix(line, "worktree "):
				wt.Path = strings.TrimPrefix(line, "worktree ")
			case strings.HasPrefix(line, "HEAD "):
				wt.Head = strings.TrimPrefix(line, "HEAD ")
			case strings.HasPrefix(line, "branch "):
				branch := strings.TrimPrefix(line, "branch ")
				wt.Branch = strings.TrimPrefix(branch, "refs/heads/")
			}
		}
		if i == 0 {
			// Primary worktree: name derived from branch name.
			if wt.Branch != "" {
				wt.Name = wt.Branch
			} else {
				wt.Name = branchMain
			}
		} else {
			// Linked worktrees: name is the last path segment.
			wt.Name = filepath.Base(wt.Path)
		}
		worktrees = append(worktrees, wt)
	}
	return worktrees
}

// Repo represents a git repository found in the workspace.
type Repo struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Branch     string `json:"branch"`
	Dirty      bool   `json:"dirty"`
	LastCommit int64  `json:"lastCommit"` // unix timestamp of latest commit
}

// IsGitRepo reports whether dir is a git repository.
// It handles both regular repos (.git is a directory) and submodules (.git is a file).
func IsGitRepo(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, ".git"))
	return err == nil
}

// DiscoverRepos finds git repositories in subdirectories of dir.
// It recurses into non-git directories to find nested repos (e.g. "group/repo"),
// but stops recursing once a .git entry is found (submodules are not listed separately).
// Metadata (branch, dirty, lastCommit) is fetched in parallel via goroutines.
func DiscoverRepos(dir string) ([]Repo, error) {
	// Phase 1: collect repo paths (fast, no git commands).
	var paths []Repo
	discoverPaths(dir, dir, &paths)

	// Phase 2: fill metadata in parallel.
	var wg sync.WaitGroup
	repos := make([]Repo, len(paths))
	for i, r := range paths {
		repos[i] = r
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			d := repos[idx].Path
			repos[idx].Branch = gitBranch(d)
			repos[idx].Dirty = gitDirty(d)
			repos[idx].LastCommit = gitLastCommit(d)
		}(i)
	}
	wg.Wait()
	return repos, nil
}

func discoverPaths(baseDir, currentDir string, repos *[]Repo) {
	entries, err := os.ReadDir(currentDir)
	if err != nil {
		return
	}

	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}

		subdir := filepath.Join(currentDir, entry.Name())

		if IsGitRepo(subdir) {
			relPath, err := filepath.Rel(baseDir, subdir)
			if err != nil {
				continue
			}
			*repos = append(*repos, Repo{
				Name: filepath.ToSlash(relPath),
				Path: subdir,
			})
			// Stop here — don't recurse into git repo subdirectories.
		} else {
			discoverPaths(baseDir, subdir, repos)
		}
	}
}

func gitBranch(dir string) string {
	out, err := exec.Command("git", "-C", dir, "rev-parse", "--abbrev-ref", "HEAD").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func gitLastCommit(dir string) int64 {
	out, err := exec.Command("git", "-C", dir, "log", "-1", "--format=%ct").Output()
	if err != nil {
		return 0
	}
	var ts int64
	fmt.Sscanf(strings.TrimSpace(string(out)), "%d", &ts)
	return ts
}

func gitDirty(dir string) bool {
	out, err := exec.Command("git", "-C", dir, "status", "--porcelain").Output()
	if err != nil {
		return false
	}
	return len(strings.TrimSpace(string(out))) > 0
}

// ListBranches returns local branch names for a git repository.
// If repoDir is empty, git runs in the current working directory.
func ListBranches(repoDir string) ([]string, error) {
	var cmd *exec.Cmd
	if repoDir != "" {
		cmd = exec.Command("git", "-C", repoDir, "for-each-ref", "--format=%(refname:short)", "refs/heads/")
	} else {
		cmd = exec.Command("git", "for-each-ref", "--format=%(refname:short)", "refs/heads/")
	}
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("git for-each-ref failed: %w", err)
	}
	var branches []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line != "" {
			branches = append(branches, line)
		}
	}
	return branches, nil
}

// DefaultBranch returns "main" if it exists in the repo, "master" if it exists,
// or the first branch found. Falls back to "main" if no branches are found.
func DefaultBranch(repoDir string) string {
	branches, err := ListBranches(repoDir)
	if err != nil || len(branches) == 0 {
		return branchMain
	}
	for _, b := range branches {
		if b == branchMain {
			return b
		}
	}
	for _, b := range branches {
		if b == branchMaster {
			return b
		}
	}
	return branches[0]
}

// ClearRepo resets all changes in a repo (git checkout . + git clean -fd).
// It also resets submodules recursively so nested dirty state is cleared.
func ClearRepo(repoDir string) error {
	if out, err := exec.Command("git", "-C", repoDir, "checkout", ".").CombinedOutput(); err != nil {
		return fmt.Errorf("checkout: %s", strings.TrimSpace(string(out)))
	}
	if out, err := exec.Command("git", "-C", repoDir, "clean", "-fd").CombinedOutput(); err != nil {
		return fmt.Errorf("clean: %s", strings.TrimSpace(string(out)))
	}
	// Reset submodules recursively — ignore errors (repo may have no submodules).
	_ = exec.Command("git", "-C", repoDir, "submodule", "foreach", "--recursive",
		"git checkout . && git clean -fd").Run()
	return nil
}

// CurrentBranch returns the current branch name of the repository.
func CurrentBranch(repoDir string) string {
	return gitBranch(repoDir)
}

// DeleteBranch deletes a local branch. Protected branches (main, master) and the
// currently checked-out branch are rejected.
func DeleteBranch(repoDir, branch string, force bool) error {
	if branch == branchMain || branch == branchMaster {
		return fmt.Errorf("cannot delete protected branch %q", branch)
	}
	current := gitBranch(repoDir)
	if branch == current {
		return fmt.Errorf("cannot delete the currently checked-out branch %q", branch)
	}
	flag := "-d"
	if force {
		flag = "-D"
	}
	args := []string{"-C", repoDir, "branch", flag, branch}
	out, err := exec.Command("git", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s", strings.TrimSpace(string(out)))
	}
	return nil
}

// DeleteWorktree removes a linked worktree. The main worktree cannot be removed.
func DeleteWorktree(repoDir, worktreeName string) error {
	worktrees, err := GitWorktrees(repoDir)
	if err != nil {
		return err
	}
	for i, wt := range worktrees {
		if wt.Name == worktreeName {
			if i == 0 {
				return fmt.Errorf("cannot remove the main worktree")
			}
			out, errRm := exec.Command("git", "-C", repoDir, "worktree", "remove", wt.Path).CombinedOutput()
			if errRm != nil {
				return fmt.Errorf("%s", strings.TrimSpace(string(out)))
			}
			return nil
		}
	}
	return fmt.Errorf("worktree %q not found", worktreeName)
}

// DiffInRepo runs git diff in a specific repository directory.
func DiffInRepo(repoDir string, args []string) (*DiffResult, error) {
	cmdArgs := append([]string{"-C", repoDir, "diff", "--unified=3", "--no-color"}, args...)
	cmd := exec.Command("git", cmdArgs...)
	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			if exitErr.ExitCode() != 1 {
				return nil, fmt.Errorf("git diff: %w", err)
			}
		} else {
			return nil, fmt.Errorf("git diff: %w", err)
		}
	}

	raw := string(out)
	result := Parse(raw)
	result.RawDiff = raw
	return result, nil
}
