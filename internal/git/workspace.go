package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Repo represents a git repository found in the workspace.
type Repo struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	Branch string `json:"branch"`
	Dirty  bool   `json:"dirty"`
}

// IsGitRepo checks if the given directory is a git repository.
func IsGitRepo(dir string) bool {
	gitDir := filepath.Join(dir, ".git")
	info, err := os.Stat(gitDir)
	if err != nil {
		return false
	}
	return info.IsDir()
}

// DiscoverRepos finds all git repositories in immediate subdirectories of dir.
func DiscoverRepos(dir string) ([]Repo, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}

	var repos []Repo
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		subdir := filepath.Join(dir, entry.Name())
		if !IsGitRepo(subdir) {
			continue
		}

		repo := Repo{
			Name: entry.Name(),
			Path: subdir,
		}

		// Get current branch
		cmd := exec.Command("git", "-C", subdir, "rev-parse", "--abbrev-ref", "HEAD")
		if out, err := cmd.Output(); err == nil {
			repo.Branch = strings.TrimSpace(string(out))
		}

		// Check if dirty
		cmd = exec.Command("git", "-C", subdir, "status", "--porcelain")
		if out, err := cmd.Output(); err == nil {
			repo.Dirty = len(strings.TrimSpace(string(out))) > 0
		}

		repos = append(repos, repo)
	}

	return repos, nil
}

// DiffInRepo runs git diff in a specific repository directory.
func DiffInRepo(repoDir string, args []string) (*DiffResult, error) {
	cmdArgs := append([]string{"-C", repoDir, "diff", "--unified=3", "--no-color"}, args...)
	cmd := exec.Command("git", cmdArgs...)
	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			if exitErr.ExitCode() != 1 {
				return nil, err
			}
		} else {
			return nil, err
		}
	}

	raw := string(out)
	result := Parse(raw)
	result.RawDiff = raw
	return result, nil
}
