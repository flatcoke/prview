package git

import (
	"testing"
)

const sampleDiff = `diff --git a/main.go b/main.go
index abc1234..def5678 100644
--- a/main.go
+++ b/main.go
@@ -1,5 +1,6 @@
 package main
 
 import (
+	"fmt"
 	"os"
 )
@@ -10,3 +11,5 @@ func main() {
 	_ = os.Args
+	fmt.Println("hello")
+	fmt.Println("world")
 }
diff --git a/new.go b/new.go
new file mode 100644
--- /dev/null
+++ b/new.go
@@ -0,0 +1,3 @@
+package main
+
+func init() {}
diff --git a/old.go b/old.go
deleted file mode 100644
--- a/old.go
+++ /dev/null
@@ -1,2 +0,0 @@
-package main
-
`

func TestParse(t *testing.T) {
	result := Parse(sampleDiff)

	if len(result.Files) != 3 {
		t.Fatalf("expected 3 files, got %d", len(result.Files))
	}

	// File 1: modified
	f := result.Files[0]
	if f.OldName != "main.go" || f.NewName != "main.go" {
		t.Errorf("file 0: unexpected names: %q / %q", f.OldName, f.NewName)
	}
	if f.Status != "modified" {
		t.Errorf("file 0: expected modified, got %s", f.Status)
	}
	if f.Additions != 3 || f.Deletions != 0 {
		t.Errorf("file 0: expected +3/-0, got +%d/-%d", f.Additions, f.Deletions)
	}
	if len(f.Hunks) != 2 {
		t.Errorf("file 0: expected 2 hunks, got %d", len(f.Hunks))
	}

	// File 2: added
	f = result.Files[1]
	if f.Status != "added" {
		t.Errorf("file 1: expected added, got %s", f.Status)
	}
	if f.Additions != 3 {
		t.Errorf("file 1: expected +3, got +%d", f.Additions)
	}

	// File 3: deleted
	f = result.Files[2]
	if f.Status != "deleted" {
		t.Errorf("file 2: expected deleted, got %s", f.Status)
	}
	if f.Deletions != 2 {
		t.Errorf("file 2: expected -2, got -%d", f.Deletions)
	}

	// Totals
	if result.Additions != 6 {
		t.Errorf("expected 6 total additions, got %d", result.Additions)
	}
	if result.Deletions != 2 {
		t.Errorf("expected 2 total deletions, got %d", result.Deletions)
	}
}

func TestParseEmpty(t *testing.T) {
	result := Parse("")
	if len(result.Files) != 0 {
		t.Errorf("expected 0 files, got %d", len(result.Files))
	}
}

func TestParseHunkHeader(t *testing.T) {
	h := &Hunk{}
	parseHunkHeader("@@ -10,3 +11,5 @@ func main() {", h)
	if h.OldStart != 10 || h.OldLines != 3 {
		t.Errorf("old range: got %d,%d", h.OldStart, h.OldLines)
	}
	if h.NewStart != 11 || h.NewLines != 5 {
		t.Errorf("new range: got %d,%d", h.NewStart, h.NewLines)
	}
}

func TestParseRename(t *testing.T) {
	raw := `diff --git a/old_name.go b/new_name.go
similarity index 95%
rename from old_name.go
rename to new_name.go
index abc..def 100644
--- a/old_name.go
+++ b/new_name.go
@@ -1,3 +1,3 @@
 package main
-var x = 1
+var x = 2
`
	result := Parse(raw)
	if len(result.Files) != 1 {
		t.Fatalf("expected 1 file, got %d", len(result.Files))
	}
	f := result.Files[0]
	if f.Status != "renamed" {
		t.Errorf("expected renamed, got %s", f.Status)
	}
	if f.OldName != "old_name.go" || f.NewName != "new_name.go" {
		t.Errorf("unexpected names: %q → %q", f.OldName, f.NewName)
	}
}
