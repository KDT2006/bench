// Command benchscope-proxy sits between the website and the local execution servers.
//
// The website sends POST /api/execute with {name, byteCount, fenced, code, language, arch}.
// The proxy picks the local server for that language and OS/architecture, forwards
// {name, byteCount, fenced, code} to it, and converts the local server's raw results (see schema.go) into the
// shape the website reads.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"sort"
	"strings"
	"time"
)

const bodyLimit = 1 << 20 // 1 MiB

// ExecuteRequest is what the website sends to the proxy.
type ExecuteRequest struct {
	CompilerFlags []string `json:"compilerFlags,omitempty"`
	Name          string   `json:"name"`
	ByteCount     int64    `json:"byteCount"`
	Fenced        bool     `json:"fenced"`
	Code          string   `json:"code"` // high-level code with the #directives
	Language      string   `json:"language"`
	Arch          string   `json:"arch"` // OS/architecture, e.g. linux/amd64
}

// LocalRequest is what the proxy sends to a local execution server.
type LocalRequest struct {
	CompilerFlags []string `json:"compilerFlags,omitempty"`
	Name          string   `json:"name"`
	ByteCount     int64    `json:"byteCount"`
	Fenced        bool     `json:"fenced"`
	Code          string   `json:"code"`
}

// backends maps "language/os/arch" (e.g. "go/linux/amd64") to a local server's execute URL.
type backends map[string]string

func (b backends) String() string { return fmt.Sprint(map[string]string(b)) }

// Set parses one -backend flag: "go/darwin/arm64=http://192.168.1.20:6969/execute".
func (b backends) Set(value string) error {
	key, target, ok := strings.Cut(value, "=")
	parts := strings.Split(key, "/")
	if !ok || len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" || target == "" {
		return errors.New("want language/os/arch=URL, e.g. go/linux/amd64=http://127.0.0.1:6969/execute")
	}
	b[strings.ToLower(key)] = target
	return nil
}

// envTargets names the environment variables that hold each laptop executor's public URL
// (e.g. an ngrok URL). An empty or unset variable leaves that target unconfigured.
var envTargets = []struct{ name, key string }{
	{"GO_LINUX_URL", "go/linux/amd64"},
	{"PYTHON_LINUX_URL", "python/linux/amd64"},
	{"GO_MAC_URL", "go/darwin/arm64"},
	{"PYTHON_MAC_URL", "python/darwin/arm64"},
}

// applyEnv adds a backend for each non-empty envTargets variable. The value may be a base
// URL ("https://abc.ngrok-free.app") or a full execute URL; /execute is appended if missing.
func applyEnv(b backends, getenv func(string) string) {
	for _, target := range envTargets {
		value := strings.TrimRight(strings.TrimSpace(getenv(target.name)), "/")
		if value == "" {
			continue
		}
		if !strings.HasSuffix(value, "/execute") {
			value += "/execute"
		}
		b[target.key] = value
	}
}

type proxy struct {
	backends backends
	client   *http.Client
	origin   string // value for Access-Control-Allow-Origin; empty disables CORS headers
}

func main() {
	// Hosts such as Render assign the port through $PORT.
	defaultAddr := ":8080"
	if port := os.Getenv("PORT"); port != "" {
		defaultAddr = ":" + port
	}
	addr := flag.String("addr", defaultAddr, "listen address (default :$PORT when PORT is set)")
	origin := flag.String("allow-origin", "*", "origin allowed to call the proxy from a browser; empty disables CORS")
	// Servers on this machine are configured by default; -backend adds or replaces entries.
	local := runtime.GOOS + "/" + runtime.GOARCH
	targets := backends{
		"go/" + local:     "http://127.0.0.1:6969/execute",
		"python/" + local: "http://127.0.0.1:6970/execute",
	}
	applyEnv(targets, os.Getenv)
	flag.Var(targets, "backend", "language/os/arch=execute URL; repeatable; overrides the *_URL environment variables")
	flag.Parse()

	p := &proxy{
		backends: targets,
		// Benchmarks compile and then run for several seconds per sweep combination.
		client: &http.Client{Timeout: 15 * time.Minute},
		origin: *origin,
	}

	server := &http.Server{
		Addr:              *addr,
		Handler:           p.handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		// No WriteTimeout: the response waits for the benchmark to finish.
	}
	log.Printf("benchscope proxy listening on %s, backends: %v", *addr, targets)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func (p *proxy) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", p.health)
	mux.HandleFunc("POST /api/execute", p.execute)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fail(w, http.StatusNotFound, "No route matches %s %s.", r.Method, r.URL.Path)
	})
	return p.withCORS(mux)
}

func (p *proxy) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if p.origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", p.origin)
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Health contains metadata fetched from each configured execution target.
type ExecutorHealth struct {
	Status    string          `json:"status"`
	Hostname  string          `json:"hostname"`
	OS        string          `json:"os"`
	Arch      string          `json:"arch"`
	CPUs      int             `json:"cpus"`
	Languages []string        `json:"languages"`
	Hardware  json.RawMessage `json:"hardware,omitempty"`
}

type TargetError struct {
	Language string `json:"language"`
	Arch     string `json:"arch"` // configured os/arch, e.g. darwin/arm64
	Message  string `json:"message"`
}

type Health struct {
	Status      string           `json:"status"`
	Machines    []ExecutorHealth `json:"machines"`
	Unavailable []TargetError    `json:"unavailable"`
}

func (p *proxy) targetHealth(ctx context.Context, language, arch, endpoint string) (ExecutorHealth, error) {
	var info ExecutorHealth
	target, err := url.Parse(endpoint)
	if err != nil {
		return info, err
	}
	// A health endpoint is a sibling of /execute, preserving deployment prefixes.
	target.Path = strings.TrimSuffix(strings.TrimRight(target.Path, "/"), "/execute") + "/health"
	target.RawPath, target.RawQuery, target.Fragment = "", "", ""
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return info, err
	}
	response, err := p.client.Do(req)
	if err != nil {
		return info, fmt.Errorf("executor health is unreachable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return info, fmt.Errorf("executor health returned %d; update or check the executor", response.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, bodyLimit)).Decode(&info); err != nil {
		return info, fmt.Errorf("invalid executor health response")
	}
	if info.Status != "ok" || info.Hostname == "" || info.OS == "" || info.Arch == "" || info.CPUs < 1 {
		return info, fmt.Errorf("incomplete executor health response")
	}
	if reported := info.OS + "/" + info.Arch; reported != arch {
		return info, fmt.Errorf("executor reports %s but is configured as %s", reported, arch)
	}
	info.Languages = []string{language}
	return info, nil
}

func (p *proxy) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	type result struct {
		machine ExecutorHealth
		err     error
	}
	keys := make([]string, 0, len(p.backends))
	for key := range p.backends {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	// One slot per backend, filled concurrently, so the response order is stable.
	results := make([]result, len(keys))
	done := make(chan struct{})
	for i, key := range keys {
		go func() {
			language, arch, _ := strings.Cut(key, "/")
			machine, err := p.targetHealth(ctx, language, arch, p.backends[key])
			results[i] = result{machine, err}
			done <- struct{}{}
		}()
	}
	for range keys {
		<-done
	}
	health := Health{Status: "ok", Machines: []ExecutorHealth{}, Unavailable: []TargetError{}}
	for i, entry := range results {
		if entry.err != nil {
			language, arch, _ := strings.Cut(keys[i], "/")
			health.Status = "degraded"
			health.Unavailable = append(health.Unavailable, TargetError{language, arch, entry.err.Error()})
		} else {
			health.Machines = append(health.Machines, entry.machine)
		}
	}
	writeJSON(w, http.StatusOK, health)
}

func (p *proxy) execute(w http.ResponseWriter, r *http.Request) {
	var req ExecuteRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, bodyLimit))
	if err := dec.Decode(&req); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			fail(w, http.StatusRequestEntityTooLarge, "Request body must be smaller than 1 MiB.")
		} else {
			fail(w, http.StatusBadRequest, "Invalid JSON body: %v", err)
		}
		return
	}
	if msg := validate(req); msg != "" {
		fail(w, http.StatusBadRequest, "%s", msg)
		return
	}
	language := strings.ToLower(strings.TrimSpace(req.Language))
	arch := strings.ToLower(strings.TrimSpace(req.Arch))
	target, ok := p.backends[language+"/"+arch]
	if !ok {
		fail(w, http.StatusBadRequest, "No local server is configured for %s on %s.", req.Language, req.Arch)
		return
	}

	body, _ := json.Marshal(LocalRequest{CompilerFlags: req.CompilerFlags, Name: req.Name, ByteCount: req.ByteCount, Fenced: req.Fenced, Code: req.Code})
	upstream, err := http.NewRequestWithContext(r.Context(), http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		fail(w, http.StatusInternalServerError, "Could not build the request to the local server: %v", err)
		return
	}
	upstream.Header.Set("Content-Type", "application/json")

	log.Printf("execute %q (%s, %s) -> %s", req.Name, language, arch, target)
	start := time.Now()
	resp, err := p.client.Do(upstream)
	if err != nil {
		fail(w, http.StatusBadGateway, "Could not reach the %s %s local server at %s: %v", language, arch, target, err)
		return
	}
	defer resp.Body.Close()
	result, err := io.ReadAll(resp.Body)
	if err != nil {
		fail(w, http.StatusBadGateway, "Could not read the local server's response: %v", err)
		return
	}
	log.Printf("execute %q finished with %d in %s", req.Name, resp.StatusCode, time.Since(start).Round(time.Millisecond))

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		// Pass the local server's error text through so the website can show it.
		msg := strings.TrimSpace(string(result))
		var structured struct {
			Message string `json:"message"`
			Error   string `json:"error"`
		}
		if json.Unmarshal(result, &structured) == nil {
			if structured.Message != "" {
				msg = structured.Message
			} else if structured.Error != "" {
				msg = structured.Error
			}
		}
		if msg == "" {
			msg = http.StatusText(resp.StatusCode)
		}
		fail(w, http.StatusBadGateway, "Local server returned %d: %s", resp.StatusCode, msg)
		return
	}
	converted, err := convertResponse(result)
	if err != nil {
		fail(w, http.StatusBadGateway, "Local server returned an unexpected response: %v", err)
		return
	}
	writeJSON(w, http.StatusOK, converted)
}

func validate(req ExecuteRequest) string {
	if len(req.CompilerFlags) > 64 {
		return "compilerFlags must contain at most 64 arguments."
	}
	for _, arg := range req.CompilerFlags {
		if arg == "" || len(arg) > 4096 || strings.ContainsRune(arg, 0) {
			return "compilerFlags must contain nonempty arguments of at most 4096 bytes, without NUL characters."
		}
	}
	switch {
	case strings.TrimSpace(req.Name) == "":
		return "name is required."
	case req.ByteCount < 0:
		return "byteCount must be zero or more."
	case strings.TrimSpace(req.Code) == "":
		return "code is required."
	case strings.TrimSpace(req.Language) == "":
		return "language is required."
	case strings.TrimSpace(req.Arch) == "":
		return "arch is required."
	}
	return ""
}

func writeRaw(w http.ResponseWriter, status int, data []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	data, _ := json.Marshal(value)
	writeRaw(w, status, data)
}

func fail(w http.ResponseWriter, status int, format string, args ...any) {
	writeJSON(w, status, map[string]string{"message": fmt.Sprintf(format, args...)})
}
