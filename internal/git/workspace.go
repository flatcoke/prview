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

// DiscoverRepos finds all git repositories recursively in subdirectories of dir.
// Repo names are relative paths from dir, using forward slashes (e.g. "meta/web").
// Hidden directories (starting with ".") are skipped.
// Once a git repo is found, its subdirectories are not recursed into.
func DiscoverRepos(dir string) ([]Repo, error) {
	var repos []Repo
	if err := discoverRecursive(dir, dir, &repos); err != nil {
		return nil, err
	}
	return repos, nil
}

func discoverRecursive(baseDir, currentDir string, repos *[]Repo) error {
	entries, err := os.ReadDir(currentDir)
	if err != nil {
		return err
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
			repo := Repo{
				Name: filepath.ToSlash(relPath),
				Path: subdir,
			}
			repo.Branch = gitBranch(subdir)
			repo.Dirty = gitDirty(subdir)
			*repos = append(*repos, repo)
			// Do not recurse into a git repo's subdirectories.
		} else {
			// Not a git repo — recurse into it to find nested repos.
			// Ignore errors for unreadable directories.
			_ = discoverRecursive(baseDir, subdir, repos)
		}
	}

	return nil
}

func gitBranch(dir string) string {
	out, err := exec.Command("git", "-C", dir, "rev-parse", "--abbrev-ref", "HEAD").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func gitDirty(dir string) bool {
	out, err := exec.Command("git", "-C", dir, "status", "--porcelain").Output()
	if err != nil {
		return false
	}
	return len(strings.TrimSpace(string(out))) > 0
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
