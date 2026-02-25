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
	"runtime"
	"syscall"
	"time"

	"github.com/flatcoke/prview/internal/server"
)

func main() {
	port := flag.Int("port", 8888, "Port to listen on")
	staged := flag.Bool("staged", false, "Show staged changes")
	all := flag.Bool("all", false, "Show staged + unstaged changes")
	noOpen := flag.Bool("no-open", false, "Don't open browser automatically")
	flag.Parse()

	cfg := server.Config{
		Port:    *port,
		Staged:  *staged,
		All:     *all,
		RefArgs: flag.Args(),
	}

	handler := server.New(cfg)
	addr := fmt.Sprintf(":%d", cfg.Port)
	srv := &http.Server{Addr: addr, Handler: handler}

	// Graceful shutdown
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
