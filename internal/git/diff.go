package git

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// Hunk represents a single diff hunk.
type Hunk struct {
	OldStart int    `json:"oldStart"`
	OldLines int    `json:"oldLines"`
	NewStart int    `json:"newStart"`
	NewLines int    `json:"newLines"`
	Header   string `json:"header"`
	Lines    []Line `json:"lines"`
}

// Line represents a single line in a diff hunk.
type Line struct {
	Type    string `json:"type"` // "add", "del", "context"
	Content string `json:"content"`
}

// FileDiff represents the diff for a single file.
type FileDiff struct {
	OldName   string `json:"oldName"`
	NewName   string `json:"newName"`
	Status    string `json:"status"` // "modified", "added", "deleted", "renamed"
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	IsBinary  bool   `json:"isBinary"`
	Hunks     []Hunk `json:"hunks"`
}

// DiffResult holds the complete diff output.
type DiffResult struct {
	Files     []FileDiff `json:"files"`
	Additions int        `json:"additions"`
	Deletions int        `json:"deletions"`
	RawDiff   string     `json:"rawDiff"`
}

// Diff runs git diff and returns parsed results.
func Diff(args []string) (*DiffResult, error) {
	cmdArgs := append([]string{"diff", "--unified=3", "--no-color"}, args...)
	cmd := exec.Command("git", cmdArgs...)
	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			// git diff exits 1 when there are differences
			if exitErr.ExitCode() == 1 {
				// that's fine
			} else {
				return nil, fmt.Errorf("git diff failed: %s", string(exitErr.Stderr))
			}
		} else {
			return nil, fmt.Errorf("git diff failed: %w", err)
		}
	}

	raw := string(out)
	result := Parse(raw)
	result.RawDiff = raw
	return result, nil
}

// Parse parses unified diff output into structured data.
func Parse(raw string) *DiffResult {
	result := &DiffResult{}
	if strings.TrimSpace(raw) == "" {
		return result
	}

	lines := strings.Split(raw, "\n")
	var current *FileDiff
	var currentHunk *Hunk

	for i := 0; i < len(lines); i++ {
		line := lines[i]

		// New file diff header
		if strings.HasPrefix(line, "diff --git ") {
			if current != nil {
				if currentHunk != nil {
					current.Hunks = append(current.Hunks, *currentHunk)
					currentHunk = nil
				}
				result.Files = append(result.Files, *current)
			}
			current = &FileDiff{Status: "modified"}
			currentHunk = nil

			parts := strings.SplitN(line, " b/", 2)
			if len(parts) == 2 {
				current.NewName = parts[1]
			}
			aParts := strings.SplitN(line, " a/", 2)
			if len(aParts) == 2 {
				aName := strings.SplitN(aParts[1], " b/", 2)
				if len(aName) > 0 {
					current.OldName = aName[0]
				}
			}
			continue
		}

		if current == nil {
			continue
		}

		// File mode lines
		if strings.HasPrefix(line, "new file mode") {
			current.Status = "added"
			current.OldName = "/dev/null"
			continue
		}
		if strings.HasPrefix(line, "deleted file mode") {
			current.Status = "deleted"
			current.NewName = "/dev/null"
			continue
		}
		if strings.HasPrefix(line, "rename from ") {
			current.Status = "renamed"
			current.OldName = strings.TrimPrefix(line, "rename from ")
			continue
		}
		if strings.HasPrefix(line, "rename to ") {
			current.NewName = strings.TrimPrefix(line, "rename to ")
			continue
		}
		if strings.HasPrefix(line, "Binary files") {
			current.IsBinary = true
			continue
		}

		// Skip --- and +++ lines
		if strings.HasPrefix(line, "--- ") || strings.HasPrefix(line, "+++ ") {
			continue
		}
		// Skip index lines
		if strings.HasPrefix(line, "index ") || strings.HasPrefix(line, "similarity index") || strings.HasPrefix(line, "old mode") || strings.HasPrefix(line, "new mode") {
			continue
		}

		// Hunk header
		if strings.HasPrefix(line, "@@") {
			if currentHunk != nil {
				current.Hunks = append(current.Hunks, *currentHunk)
			}
			currentHunk = &Hunk{Header: line}
			parseHunkHeader(line, currentHunk)
			continue
		}

		// Diff content lines
		if currentHunk != nil {
			if strings.HasPrefix(line, "+") {
				currentHunk.Lines = append(currentHunk.Lines, Line{Type: "add", Content: line[1:]})
				current.Additions++
				result.Additions++
			} else if strings.HasPrefix(line, "-") {
				currentHunk.Lines = append(currentHunk.Lines, Line{Type: "del", Content: line[1:]})
				current.Deletions++
				result.Deletions++
			} else if strings.HasPrefix(line, " ") {
				currentHunk.Lines = append(currentHunk.Lines, Line{Type: "context", Content: line[1:]})
			} else if line == `\ No newline at end of file` {
				// skip
			}
		}
	}

	// Flush last file
	if current != nil {
		if currentHunk != nil {
			current.Hunks = append(current.Hunks, *currentHunk)
		}
		result.Files = append(result.Files, *current)
	}

	return result
}

func parseHunkHeader(header string, hunk *Hunk) {
	// @@ -oldStart,oldLines +newStart,newLines @@
	header = strings.TrimPrefix(header, "@@ ")
	parts := strings.SplitN(header, " @@", 2)
	if len(parts) == 0 {
		return
	}
	ranges := strings.Fields(parts[0])
	for _, r := range ranges {
		if strings.HasPrefix(r, "-") {
			parseRange(r[1:], &hunk.OldStart, &hunk.OldLines)
		} else if strings.HasPrefix(r, "+") {
			parseRange(r[1:], &hunk.NewStart, &hunk.NewLines)
		}
	}
}

func parseRange(s string, start, lines *int) {
	parts := strings.SplitN(s, ",", 2)
	if len(parts) >= 1 {
		*start, _ = strconv.Atoi(parts[0])
	}
	if len(parts) == 2 {
		*lines, _ = strconv.Atoi(parts[1])
	} else {
		*lines = 1
	}
}
