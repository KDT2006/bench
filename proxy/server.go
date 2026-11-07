package main

import (
	"crypto/rand"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	pollIntervalMs = 2000             // SCHEMA.md B.3
	offlineAfter   = 10 * time.Second // B.4
	bodyLimit      = 1 << 20          // section 0
)

//go:embed fixtures/run.json
var sampleRunJSON []byte

//go:embed fixtures/examples.json
var examplesJSON []byte

type server struct {
	token   string
	origins []string
	dataDir string // empty keeps everything in memory

	mu       sync.Mutex
	machines map[string]*machine
	runs     map[string]*runRecord
	jobs     map[string]*runRecord // job ID -> its run
	benches  map[string]*bench
	shares   map[string]any
}

type machine struct {
	snapshot  map[string]any // MachineSnapshot as the agent sent it
	languages []string       // capabilities.languages
	lastSeen  time.Time
	busy      bool         // from the last poll
	queue     []*runRecord // runs waiting for this machine
	active    *runRecord   // the run whose job was handed out
}

type bench struct {
	Order     int64          `json:"order"`
	Workspace map[string]any `json:"workspace"`
}

// Run is the website's view of a run (SCHEMA.md A.2).
type Run struct {
	ID                string       `json:"id"`
	WorkspaceSnapshot any          `json:"workspaceSnapshot"`
	Machine           any          `json:"machine"`
	Status            string       `json:"status"`
	Sweep             []SweepParam `json:"sweep"`
	Rows              []any        `json:"rows"`
	StartedAt         string       `json:"startedAt"`
	FinishedAt        string       `json:"finishedAt,omitempty"`
}

// runRecord is a run plus the events relayed to the website. Extras keeps the perm.result and
// build.done fields the website does not show yet (section 6). Only exported fields are stored.
type runRecord struct {
	Run    Run               `json:"run"`
	Events []json.RawMessage `json:"events"`
	Extras []map[string]any  `json:"extras,omitempty"`

	job         *Job
	counters    map[string][]string // lane ID -> runner.counters
	handedOut   bool
	cancel      bool // the website asked to cancel
	lastSeq     int64
	missedPolls int // idle polls since the job was handed out
	machine     *machine
	notify      chan struct{} // closed and replaced on every new event
}

func (r *runRecord) finished() bool {
	return r.Run.Status == "done" || r.Run.Status == "failed" || r.Run.Status == "cancelled"
}

func newServer(token, dataDir string, origins []string) (*server, error) {
	s := &server{
		token: token, origins: origins, dataDir: dataDir,
		machines: map[string]*machine{}, runs: map[string]*runRecord{}, jobs: map[string]*runRecord{},
		benches: map[string]*bench{}, shares: map[string]any{},
	}
	sample := &runRecord{notify: make(chan struct{})}
	if err := decodeBytes(sampleRunJSON, &sample.Run); err != nil {
		return nil, fmt.Errorf("fixtures/run.json: %w", err)
	}
	s.runs[sample.Run.ID] = sample
	if dataDir == "" {
		return s, nil
	}

	for _, kind := range []string{"benches", "shares", "runs"} {
		dir := filepath.Join(dataDir, kind)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			id, ok := strings.CutSuffix(entry.Name(), ".json")
			if !ok {
				continue
			}
			data, err := os.ReadFile(filepath.Join(dir, entry.Name()))
			if err != nil {
				return nil, err
			}
			if err := s.loadOne(kind, id, data); err != nil {
				return nil, fmt.Errorf("%s/%s: %w", kind, entry.Name(), err)
			}
		}
	}
	return s, nil
}

func (s *server) loadOne(kind, id string, data []byte) error {
	switch kind {
	case "benches":
		b := &bench{}
		if err := decodeBytes(data, b); err != nil {
			return err
		}
		s.benches[id] = b
	case "shares":
		var share any
		if err := decodeBytes(data, &share); err != nil {
			return err
		}
		s.shares[id] = share
	case "runs":
		rec := &runRecord{notify: make(chan struct{})}
		if err := decodeBytes(data, rec); err != nil {
			return err
		}
		s.runs[id] = rec
		if !rec.finished() { // jobs live in memory only, so no agent can still be running it
			s.finish(rec, "failed", errorEvent("The server restarted before the run finished.", ""))
		}
	}
	return nil
}

// save writes one stored object to the data directory. Callers hold s.mu.
func (s *server) save(kind, id string, value any) {
	if s.dataDir == "" {
		return
	}
	path := filepath.Join(s.dataDir, kind, id+".json")
	data, err := json.Marshal(value)
	if err == nil {
		if err = os.WriteFile(path+".tmp", data, 0o644); err == nil {
			err = os.Rename(path+".tmp", path)
		}
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "save %s/%s: %v\n", kind, id, err)
	}
}

func removeFile(dataDir, kind, id string) error {
	return os.Remove(filepath.Join(dataDir, kind, id+".json"))
}

// ---- run state (callers hold s.mu) ----

func (s *server) emit(rec *runRecord, event map[string]any) {
	data, _ := json.Marshal(event)
	rec.Events = append(rec.Events, data)
	close(rec.notify)
	rec.notify = make(chan struct{})
}

// finish ends a run with a terminal status and event, and frees its machine.
func (s *server) finish(rec *runRecord, status string, event map[string]any) {
	if rec.finished() {
		return
	}
	if status == "failed" && rec.cancel {
		status, event = "cancelled", doneEvent() // the website asked to cancel; that wins
	}
	rec.Run.Status = status
	rec.Run.FinishedAt = isoTime(time.Now())
	s.emit(rec, event)
	if m := rec.machine; m != nil {
		if m.active == rec {
			m.active = nil
		}
		for i, queued := range m.queue {
			if queued == rec {
				m.queue = append(m.queue[:i], m.queue[i+1:]...)
				break
			}
		}
	}
	s.save("runs", rec.Run.ID, rec)
}

func doneEvent() map[string]any { return map[string]any{"type": "done"} }

func errorEvent(message, laneID string) map[string]any {
	event := map[string]any{"type": "error", "message": message}
	if laneID != "" {
		event["laneId"] = laneID
	}
	return event
}

// ---- HTTP plumbing ----

func (s *server) handler(prefix string) http.Handler {
	mux := http.NewServeMux()
	// Website (SCHEMA.md Part A)
	mux.HandleFunc("GET /machines", s.listMachines)
	mux.HandleFunc("GET /examples", func(w http.ResponseWriter, r *http.Request) { writeRaw(w, http.StatusOK, examplesJSON) })
	mux.HandleFunc("POST /parse", s.parse)
	mux.HandleFunc("POST /runs", s.startRun)
	mux.HandleFunc("GET /runs/{id}", s.getRun)
	mux.HandleFunc("GET /runs/{id}/events", s.runEvents)
	mux.HandleFunc("POST /runs/{id}/cancel", s.cancelRun)
	mux.HandleFunc("GET /benches", s.listBenches)
	mux.HandleFunc("POST /benches", s.createBench)
	mux.HandleFunc("GET /benches/{id}", s.getBench)
	mux.HandleFunc("PUT /benches/{id}", s.updateBench)
	mux.HandleFunc("DELETE /benches/{id}", s.deleteBench)
	mux.HandleFunc("POST /share", s.createShare)
	mux.HandleFunc("GET /share/{id}", s.getShare)
	// Agent (Part B)
	mux.HandleFunc("POST /agent/register", s.agentOnly(s.register))
	mux.HandleFunc("POST /agent/poll", s.agentOnly(s.poll))
	mux.HandleFunc("POST /agent/jobs/{jobId}/events", s.agentOnly(s.agentEvent))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fail(w, http.StatusNotFound, "No API resource matches this request.")
	})
	return s.withCORS(http.StripPrefix(prefix, mux))
}

// withCORS lets the configured origins call the API from the browser and refuses writes from
// any other foreign origin (A.1, 403).
func (s *server) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin == "" {
			next.ServeHTTP(w, r)
			return
		}
		parsed, err := url.Parse(origin)
		sameOrigin := err == nil && strings.EqualFold(parsed.Host, r.Host)
		allowed := sameOrigin || s.originAllowed(origin)
		if allowed && !sameOrigin {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
		}
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" && allowed {
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Last-Event-ID")
			w.Header().Set("Access-Control-Max-Age", "600")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if !allowed && r.Method != http.MethodGet && r.Method != http.MethodHead {
			fail(w, http.StatusForbidden, "Send write requests from the Benchscope origin.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *server) originAllowed(origin string) bool {
	for _, allowed := range s.origins {
		if allowed == "*" || strings.EqualFold(allowed, origin) {
			return true
		}
	}
	return false
}

func writeRaw(w http.ResponseWriter, status int, data []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	data, err := json.Marshal(value)
	if err != nil {
		fail(w, http.StatusInternalServerError, "The server could not encode the response.")
		return
	}
	writeRaw(w, status, data)
}

func writeEmpty(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func fail(w http.ResponseWriter, status int, format string, args ...any) {
	data, _ := json.Marshal(map[string]string{"message": fmt.Sprintf(format, args...)})
	writeRaw(w, status, data)
}

// decode reads a JSON body of at most 1 MiB into out, answering 400 or 413 on failure.
// Numbers decode as json.Number so stored workspaces round-trip exactly.
func decode(w http.ResponseWriter, r *http.Request, out any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, bodyLimit))
	dec.UseNumber()
	err := dec.Decode(out)
	if err == nil && dec.More() {
		err = errors.New("trailing data")
	}
	var tooLarge *http.MaxBytesError
	switch {
	case errors.As(err, &tooLarge):
		fail(w, http.StatusRequestEntityTooLarge, "Use a request body smaller than 1 MiB.")
	case err != nil:
		fail(w, http.StatusBadRequest, "Send a valid JSON request body.")
	}
	return err == nil
}

func decodeBytes(data []byte, out any) error {
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.UseNumber()
	return dec.Decode(out)
}

func isoTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// newID returns a random version 4 UUID.
func newID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
