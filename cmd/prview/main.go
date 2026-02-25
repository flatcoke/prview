package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/flatcoke/prview/internal/git"
	"github.com/flatcoke/prview/internal/server"
)

const defaultPort = 8888

var (
	version = "dev"
	commit  = "none"
)

func main() {
	port := flag.Int("port", defaultPort, "Port to listen on")
	staged := flag.Bool("staged", false, "Show staged changes")
	all := flag.Bool("all", false, "Show staged + unstaged changes")
	noOpen := flag.Bool("no-open", false, "Don't open browser automatically")
	showVersion := flag.Bool("version", false, "Print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Printf("prview %s (%s)\n", version, commit)
		os.Exit(0)
	}

	workDir, _ := os.Getwd()
	// If a positional argument is given and it's a directory, use it as workDir.
	args := flag.Args()
	if len(args) > 0 {
		if info, err := os.Stat(args[0]); err == nil && info.IsDir() {
			absPath, err := filepath.Abs(args[0])
			if err == nil {
				workDir = absPath
			}
			args = args[1:]
		}
	}

	// Detect mode: single repo vs workspace.
	isWorkspace := false
	if !git.IsGitRepo(workDir) {
		// Not a git repo — check if subdirectories contain repos.
		repos, err := git.DiscoverRepos(workDir)
		if err == nil && len(repos) > 0 {
			isWorkspace = true
			fmt.Printf("prview: workspace mode — found %d repos\n", len(repos))
		} else {
			fmt.Fprintln(os.Stderr, "prview: not a git repository and no git repos found in subdirectories")
			os.Exit(1)
		}
	}

	cfg := server.Config{
		Port:      *port,
		Staged:    *staged,
		All:       *all,
		RefArgs:   args,
		WorkDir:   workDir,
		Workspace: isWorkspace,
	}

	handler := server.New(cfg)
	addr := fmt.Sprintf(":%d", cfg.Port)
	srv := &http.Server{Addr: addr, Handler: handler}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		srv.Shutdown(shutdownCtx)
	}()

	url := fmt.Sprintf("http://localhost:%d", cfg.Port)
	fmt.Printf("prview listening on %s\n", url)

	if !*noOpen {
		openBrowser(url)
	}

	if err := srv.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatalf("server error: %v", err)
	}

	fmt.Println("\nprview stopped.")
}

// openBrowser launches the system default browser pointing at url.
func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "linux":
		cmd = exec.Command("xdg-open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		return
	}
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Start()
}
