// Command benchscope-proxy is the middle man between the website and profiler agents.
// The website submits runs, agents poll for jobs and post events back, and the server relays
// those events to the website over SSE. See SCHEMA.md for the protocol.
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func env(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok {
		return value
	}
	return fallback
}

func main() {
	addr := flag.String("addr", env("BENCHSCOPE_ADDR", ":8080"), "listen address (BENCHSCOPE_ADDR)")
	prefix := flag.String("prefix", env("BENCHSCOPE_PREFIX", "/api"), "path prefix for all routes; match VITE_API_BASE_URL (BENCHSCOPE_PREFIX)")
	dataDir := flag.String("data", env("BENCHSCOPE_DATA_DIR", ""), "directory for benches, shares and runs; empty keeps them in memory (BENCHSCOPE_DATA_DIR)")
	origins := flag.String("allow-origin", env("BENCHSCOPE_ALLOWED_ORIGINS", ""), "comma-separated origins allowed to call the API across origins, or * (BENCHSCOPE_ALLOWED_ORIGINS)")
	flag.Parse()

	token := os.Getenv("BENCHSCOPE_AGENT_TOKEN")
	if token == "" {
		log.Fatal("Set BENCHSCOPE_AGENT_TOKEN to the token profiler agents send as a Bearer token.")
	}
	var allowed []string
	for _, origin := range strings.Split(*origins, ",") {
		if origin = strings.TrimRight(strings.TrimSpace(origin), "/"); origin != "" {
			allowed = append(allowed, origin)
		}
	}

	srv, err := newServer(token, *dataDir, allowed)
	if err != nil {
		log.Fatal(err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go srv.watchMachines(ctx)

	httpServer := &http.Server{
		Addr:              *addr,
		Handler:           srv.handler(strings.TrimRight(*prefix, "/")),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       120 * time.Second,
		// No WriteTimeout: event streams stay open for the whole run. Request contexts end on
		// SIGINT/SIGTERM, so open streams close and shutdown can finish.
		BaseContext: func(net.Listener) context.Context { return ctx },
	}
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdown)
	}()

	log.Printf("Benchscope server listening on %s (routes under %q)", *addr, *prefix)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	<-drained // let in-flight requests (and their disk writes) finish
}
