package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Job is what an agent receives from a poll (SCHEMA.md B.5).
type Job struct {
	JobID        string        `json:"jobId"`
	RunID        string        `json:"runId"`
	Lanes        []JobLane     `json:"lanes"`
	Sweep        []SweepParam  `json:"sweep"`
	Permutations []Permutation `json:"permutations"`
	Fenced       bool          `json:"fenced"`
	MaxSamples   int           `json:"maxSamples"`
}

// JobLane is a workspace lane minus the website-only fields. Build and runner options pass
// through untouched; the agent interprets them.
type JobLane struct {
	ID       string            `json:"id"`
	Label    string            `json:"label"`
	Language string            `json:"language"`
	Arch     string            `json:"arch"`
	Files    map[string]string `json:"files"`
	Build    any               `json:"build"`
	Runner   any               `json:"runner"`
}

// parseWorkspace checks the little the server relies on: an object with 1-4 lanes that have
// unique IDs. It returns the workspace as sent (to store) and its lanes (to build a job).
func parseWorkspace(value any) (map[string]any, []JobLane, error) {
	ws, ok := value.(map[string]any)
	if !ok {
		return nil, nil, fmt.Errorf("Send a workspace object.")
	}
	data, _ := json.Marshal(ws)
	var typed struct {
		Lanes []JobLane `json:"lanes"`
	}
	if err := json.Unmarshal(data, &typed); err != nil || len(typed.Lanes) < 1 || len(typed.Lanes) > 4 {
		return nil, nil, fmt.Errorf("Send a workspace with one to four lanes.")
	}
	ids := map[string]bool{}
	for _, lane := range typed.Lanes {
		if lane.ID == "" || ids[lane.ID] {
			return nil, nil, fmt.Errorf("Give every lane a unique id.")
		}
		ids[lane.ID] = true
	}
	return ws, typed.Lanes, nil
}

// ---- machines ----

func offline(m *machine) bool { return time.Since(m.lastSeen) >= offlineAfter }

func (s *server) listMachines(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	out := make([]map[string]any, 0, len(s.machines))
	for _, m := range s.machines {
		item := make(map[string]any, len(m.snapshot)+2)
		for k, v := range m.snapshot {
			item[k] = v
		}
		item["status"] = "idle"
		if offline(m) {
			item["status"] = "offline"
		} else if m.busy || m.active != nil {
			item["status"] = "busy"
		}
		item["queueLength"] = len(m.queue)
		out = append(out, item)
	}
	s.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return fmt.Sprint(out[i]["id"]) < fmt.Sprint(out[j]["id"]) })
	writeJSON(w, http.StatusOK, out)
}

// pickMachine chooses an online machine with the arch and every language, shortest queue first.
func (s *server) pickMachine(arch string, languages []string) (*machine, string) {
	load := func(m *machine) int {
		if m.active != nil {
			return len(m.queue) + 1
		}
		return len(m.queue)
	}
	var best *machine
	archOnline := false
	for _, m := range s.machines {
		if m.snapshot["arch"] != arch || offline(m) {
			continue
		}
		archOnline = true
		if !containsAll(m.languages, languages) {
			continue
		}
		if best == nil || load(m) < load(best) {
			best = m
		}
	}
	switch {
	case best != nil:
		return best, ""
	case !archOnline:
		return nil, fmt.Sprintf("No %s machine is online. Start a profiler agent with that architecture and try again.", arch)
	default:
		return nil, fmt.Sprintf("No online %s machine can run %s.", arch, strings.Join(languages, " and "))
	}
}

func containsAll(have, need []string) bool {
	for _, n := range need {
		found := false
		for _, h := range have {
			found = found || h == n
		}
		if !found {
			return false
		}
	}
	return true
}

// ---- runs ----

func (s *server) parse(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DSL *string `json:"dsl"`
	}
	if !decode(w, r, &body) {
		return
	}
	if body.DSL == nil {
		fail(w, http.StatusBadRequest, "Provide a DSL string.")
		return
	}
	writeJSON(w, http.StatusOK, parseResponse(*body.DSL))
}

func (s *server) startRun(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Workspace any `json:"workspace"`
	}
	if !decode(w, r, &body) {
		return
	}
	ws, lanes, err := parseWorkspace(body.Workspace)
	if err != nil {
		fail(w, http.StatusBadRequest, "%v", err)
		return
	}

	sweep := []SweepParam{}
	haveSweep := false
	var languages []string
	counters := map[string][]string{}
	for _, lane := range lanes {
		if lane.Arch != lanes[0].Arch {
			fail(w, http.StatusBadRequest, "Use the same architecture in every lane. One machine runs the whole bench.")
			return
		}
		harness := "harness.py"
		if lane.Language == "go" {
			harness = "harness.go"
		}
		if strings.TrimSpace(lane.Files[harness]) == "" {
			fail(w, http.StatusBadRequest, "Lane %s: add %s before running.", lane.Label, harness)
			return
		}
		if dsl, ok := lane.Files["benchmark.perf"]; ok {
			parsed, err := parseSweep(dsl)
			if err != nil {
				fail(w, http.StatusUnprocessableEntity, "%v", err)
				return
			}
			if haveSweep && !reflect.DeepEqual(parsed, sweep) {
				fail(w, http.StatusUnprocessableEntity, "Use the same #sweep values in every lane.")
				return
			}
			sweep, haveSweep = parsed, true
		}
		if !containsAll(languages, []string{lane.Language}) {
			languages = append(languages, lane.Language)
		}
		runner, _ := lane.Runner.(map[string]any)
		list, _ := runner["counters"].([]any)
		for _, c := range list {
			if name, ok := c.(string); ok {
				counters[lane.ID] = append(counters[lane.ID], name)
			}
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	m, msg := s.pickMachine(lanes[0].Arch, languages)
	if m == nil {
		fail(w, http.StatusServiceUnavailable, "%s", msg)
		return
	}
	runID, jobID := newID(), newID()
	rec := &runRecord{
		Run: Run{
			ID: runID, WorkspaceSnapshot: ws, Machine: m.snapshot, Status: "queued",
			Sweep: sweep, Rows: []any{}, StartedAt: isoTime(time.Now()),
		},
		job: &Job{
			JobID: jobID, RunID: runID, Lanes: lanes, Sweep: sweep,
			Permutations: permutations(sweep), Fenced: true, MaxSamples: 10000,
		},
		counters: counters,
		machine:  m,
		notify:   make(chan struct{}),
	}
	s.runs[runID] = rec
	s.jobs[jobID] = rec
	m.queue = append(m.queue, rec)
	s.emit(rec, map[string]any{"type": "queued", "position": len(m.queue)})
	s.save("runs", runID, rec)
	writeJSON(w, http.StatusAccepted, map[string]string{"runId": runID})
}

func (s *server) getRun(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec := s.runs[r.PathValue("id")]
	if rec == nil {
		fail(w, http.StatusNotFound, "This run does not exist.")
		return
	}
	writeJSON(w, http.StatusOK, rec.Run)
}

func (s *server) cancelRun(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec := s.runs[r.PathValue("id")]
	if rec == nil {
		fail(w, http.StatusNotFound, "This run does not exist.")
		return
	}
	if !rec.finished() {
		rec.cancel = true
		if !rec.handedOut { // still queued: no agent involved (B.8)
			s.finish(rec, "cancelled", doneEvent())
		} // otherwise the agent sees cancel: true on its next poll
	}
	writeEmpty(w)
}

// runEvents streams a run's events as server-sent events (A.4), resuming after Last-Event-ID.
func (s *server) runEvents(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	rec := s.runs[r.PathValue("id")]
	s.mu.Unlock()
	if rec == nil {
		fail(w, http.StatusNotFound, "This run does not exist.")
		return
	}
	cursor, _ := strconv.Atoi(strings.TrimSpace(r.Header.Get("Last-Event-ID")))
	cursor = max(cursor, 0)

	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Time{}) // the stream outlives the server's ReadTimeout
	_ = rc.SetWriteDeadline(time.Time{})
	keepAlive := time.NewTicker(15 * time.Second)
	defer keepAlive.Stop()
	started := false
	for {
		s.mu.Lock()
		total := len(rec.Events)
		pending := append([]json.RawMessage(nil), rec.Events[min(cursor, total):]...)
		done, notify := rec.finished(), rec.notify
		s.mu.Unlock()

		if !started {
			if done && len(pending) == 0 {
				writeEmpty(w) // nothing left to send; 204 stops EventSource reconnecting
				return
			}
			w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
			w.Header().Set("Cache-Control", "no-cache, no-transform")
			w.Header().Set("X-Accel-Buffering", "no")
			w.WriteHeader(http.StatusOK)
			started = true
		}
		for _, data := range pending {
			cursor++
			if _, err := fmt.Fprintf(w, "id: %d\ndata: %s\n\n", cursor, data); err != nil {
				return
			}
		}
		if rc.Flush() != nil || (done && cursor >= total) {
			return // the terminal event has been sent
		}
		if len(pending) > 0 {
			continue
		}
		select {
		case <-r.Context().Done():
			return
		case <-notify:
		case <-keepAlive.C:
			if _, err := fmt.Fprint(w, ": keep-alive\n\n"); err != nil {
				return
			}
		}
	}
}

// ---- benches and shares ----

func (s *server) listBenches(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	list := make([]*bench, 0, len(s.benches))
	for _, b := range s.benches {
		list = append(list, b)
	}
	s.mu.Unlock()
	sort.Slice(list, func(i, j int) bool { return list[i].Order < list[j].Order })
	out := make([]any, len(list))
	for i, b := range list {
		out[i] = b.Workspace
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *server) getBench(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.benches[r.PathValue("id")]
	if b == nil {
		fail(w, http.StatusNotFound, "This bench does not exist.")
		return
	}
	writeJSON(w, http.StatusOK, b.Workspace)
}

func (s *server) createBench(w http.ResponseWriter, r *http.Request) {
	s.putBench(w, r, "")
}

func (s *server) updateBench(w http.ResponseWriter, r *http.Request) {
	s.putBench(w, r, r.PathValue("id"))
}

// putBench creates a bench (id == "") or replaces an existing one.
func (s *server) putBench(w http.ResponseWriter, r *http.Request, id string) {
	var body any
	if !decode(w, r, &body) {
		return
	}
	ws, _, err := parseWorkspace(body)
	if err != nil {
		fail(w, http.StatusBadRequest, "%v", err)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	b := &bench{Workspace: ws}
	status := http.StatusOK
	if id == "" {
		id, status = newID(), http.StatusCreated
		for _, other := range s.benches {
			b.Order = max(b.Order, other.Order)
		}
		b.Order++
	} else if existing := s.benches[id]; existing != nil {
		b.Order = existing.Order
		ws["createdAt"] = existing.Workspace["createdAt"]
	} else {
		fail(w, http.StatusNotFound, "This bench does not exist.")
		return
	}
	ws["id"] = id
	ws["updatedAt"] = isoTime(time.Now())
	s.benches[id] = b
	s.save("benches", id, b)
	writeJSON(w, status, ws)
}

func (s *server) deleteBench(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := r.PathValue("id")
	if s.benches[id] == nil {
		fail(w, http.StatusNotFound, "This bench does not exist.")
		return
	}
	delete(s.benches, id)
	if s.dataDir != "" {
		_ = removeFile(s.dataDir, "benches", id)
	}
	writeEmpty(w)
}

func (s *server) createShare(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Workspace any     `json:"workspace"`
		RunID     *string `json:"runId"`
	}
	if !decode(w, r, &body) {
		return
	}
	ws, _, err := parseWorkspace(body.Workspace)
	if err != nil {
		fail(w, http.StatusBadRequest, "%v", err)
		return
	}
	share := map[string]any{"workspace": ws}
	s.mu.Lock()
	defer s.mu.Unlock()
	if body.RunID != nil {
		if s.runs[*body.RunID] == nil {
			fail(w, http.StatusNotFound, "Choose an existing run to include.")
			return
		}
		share["runId"] = *body.RunID
	}
	id := newID()
	s.shares[id] = share
	s.save("shares", id, share)
	writeJSON(w, http.StatusCreated, map[string]string{"shareId": id})
}

func (s *server) getShare(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	share := s.shares[r.PathValue("id")]
	if share == nil {
		fail(w, http.StatusNotFound, "This share link does not exist.")
		return
	}
	writeJSON(w, http.StatusOK, share)
}
