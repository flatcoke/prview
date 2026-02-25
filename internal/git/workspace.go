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
// Handles both regular repos (.git is a directory) and submodules (.git is a file).
func IsGitRepo(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, ".git"))
	return err == nil
}

// DiscoverRepos finds git repositories in subdirectories of dir.
// It recurses into non-git directories to find nested repos (e.g. "group/repo"),
// but stops recursing once a .git is found (submodules are not listed separately).
func DiscoverRepos(dir string) ([]Repo, error) {
	var repos []Repo
	discoverRecursive(dir, dir, &repos)
	return repos, nil
}

func discoverRecursive(baseDir, currentDir string, repos *[]Repo) {
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
				Name:   filepath.ToSlash(relPath),
				Path:   subdir,
				Branch: gitBranch(subdir),
				Dirty:  gitDirty(subdir),
			})
			// Stop here — don't recurse into git repo subdirectories.
		} else {
			discoverRecursive(baseDir, subdir, repos)
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
