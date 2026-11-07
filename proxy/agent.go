package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// missedPollLimit is how many polls (about 10 s) an agent may make without reporting the job it
// was handed before the run fails: the poll response was lost or the agent dropped the job.
const missedPollLimit = 5

// counterMetric maps runner.counters names to metric keys (SCHEMA.md section 6).
var counterMetric = map[string]string{
	"cycles": "cycles", "time": "timeNs", "pageFaults": "pageFaults", "cacheMisses": "cacheMisses", "throughput": "throughput",
}

func (s *server) agentOnly(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || subtle.ConstantTimeCompare([]byte(token), []byte(s.token)) != 1 {
			w.Header().Set("WWW-Authenticate", `Bearer realm="benchscope-agent"`)
			fail(w, http.StatusUnauthorized, "Send the agent token as a Bearer token.")
			return
		}
		next(w, r)
	}
}

// watchMachines fails the job of any machine that stops polling (B.4).
func (s *server) watchMachines(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.mu.Lock()
			for _, m := range s.machines {
				if m.active != nil && offline(m) {
					s.finish(m.active, "failed", errorEvent("The machine went offline.", ""))
				}
			}
			s.mu.Unlock()
		}
	}
}

// register (B.3) stores the machine snapshot. Registering again replaces it.
func (s *server) register(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Machine      map[string]any `json:"machine"`
		Capabilities struct {
			Languages []string `json:"languages"`
		} `json:"capabilities"`
	}
	if !decode(w, r, &body) {
		return
	}
	id, _ := body.Machine["id"].(string)
	arch, _ := body.Machine["arch"].(string)
	if id == "" || arch == "" {
		fail(w, http.StatusBadRequest, "Send a machine snapshot with an id and arch.")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.machines[id]
	if m == nil {
		m = &machine{}
		s.machines[id] = m
	} else if m.active != nil {
		// An agent only registers at startup, so the job it had is gone.
		s.finish(m.active, "failed", errorEvent("The machine restarted during the run.", ""))
	}
	m.snapshot, m.languages = body.Machine, body.Capabilities.Languages
	m.lastSeen, m.busy = time.Now(), false
	writeJSON(w, http.StatusOK, map[string]any{"machineId": id, "pollIntervalMs": pollIntervalMs})
}

// poll (B.4) is the heartbeat, job pickup and cancel check in one.
func (s *server) poll(w http.ResponseWriter, r *http.Request) {
	var body struct {
		MachineID string  `json:"machineId"`
		Status    string  `json:"status"`
		JobID     *string `json:"jobId"`
	}
	if !decode(w, r, &body) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.machines[body.MachineID]
	if m == nil {
		fail(w, http.StatusNotFound, "Register this machine first.")
		return
	}
	m.lastSeen, m.busy = time.Now(), body.Status == "busy"
	reporting := ""
	if m.busy && body.JobID != nil {
		reporting = *body.JobID
	}

	response := struct {
		Job    *Job `json:"job"`
		Cancel bool `json:"cancel"`
	}{}
	active := m.active
	if reporting != "" {
		// Cancel a job the website cancelled, or one this server is not running here.
		response.Cancel = active == nil || active.job.JobID != reporting || active.cancel
	}
	if active != nil {
		if active.job.JobID == reporting {
			active.missedPolls = 0
		} else if active.missedPolls++; active.missedPolls >= missedPollLimit {
			s.finish(active, "failed", errorEvent("The machine stopped the job unexpectedly.", ""))
		}
	}
	if !m.busy && m.active == nil && len(m.queue) > 0 {
		rec := m.queue[0]
		m.queue = m.queue[1:]
		rec.handedOut, rec.missedPolls, m.active = true, 0, rec
		response.Job = rec.job
	}
	writeJSON(w, http.StatusOK, response)
}

// agentEvent (B.6) translates one agent event into website run events (section 6).
func (s *server) agentEvent(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !decode(w, r, &body) {
		return
	}
	n, _ := body["seq"].(json.Number)
	seq, err := n.Int64()
	if err != nil || seq < 1 {
		fail(w, http.StatusBadRequest, "Send seq as a whole number starting at 1.")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	rec := s.jobs[r.PathValue("jobId")]
	switch {
	case rec == nil || !rec.handedOut:
		fail(w, http.StatusNotFound, "This job does not exist.")
		return
	case seq <= rec.lastSeq:
		writeEmpty(w) // a retry of an event already handled
		return
	case rec.finished():
		fail(w, http.StatusConflict, "This job has already finished.")
		return
	}

	laneID, _ := body["laneId"].(string)
	message, _ := body["message"].(string)
	switch body["type"] {
	case "job.accepted":
	case "job.rejected":
		if message == "" {
			message = "The machine rejected the job."
		}
		s.finish(rec, "failed", errorEvent(message, ""))
	case "build.start":
		if rec.Run.Status == "queued" {
			rec.Run.Status = "building"
		}
		s.emit(rec, map[string]any{"type": "build_start", "laneId": laneID})
	case "build.done":
		s.emit(rec, map[string]any{"type": "build_done", "laneId": laneID, "ok": body["ok"] == true, "log": body["log"]})
		rec.Extras = append(rec.Extras, map[string]any{"type": "build.done", "laneId": laneID, "toolchain": body["toolchain"]})
	case "perm.start":
		rec.Run.Status = "running"
		s.emit(rec, map[string]any{"type": "perm_start", "laneId": laneID, "index": body["index"], "total": body["total"], "params": body["params"]})
	case "log":
		s.emit(rec, map[string]any{"type": "stderr", "laneId": laneID, "text": body["text"]})
	case "perm.result":
		metrics, _ := body["metrics"].(map[string]any)
		picked := map[string]any{}
		for _, counter := range rec.counters[laneID] {
			if key := counterMetric[counter]; metrics[key] != nil {
				picked[key] = metrics[key]
			}
		}
		row := map[string]any{"laneId": laneID, "params": body["params"], "reps": body["reps"], "metrics": picked}
		if samples, _ := body["samples"].([]any); len(samples) > 0 {
			row["samples"] = samples
		}
		rec.Run.Rows = append(rec.Run.Rows, row)
		s.emit(rec, map[string]any{"type": "result", "laneId": laneID, "row": row})
		delete(body, "samples") // already in the row; keep the rest for later website versions
		rec.Extras = append(rec.Extras, body)
	case "job.finished":
		switch body["status"] {
		case "done":
			s.finish(rec, "done", doneEvent())
		case "cancelled":
			s.finish(rec, "cancelled", doneEvent())
		default:
			if message == "" {
				message = "The run failed."
			}
			s.finish(rec, "failed", errorEvent(message, laneID))
		}
	default:
		fail(w, http.StatusBadRequest, "Send an event type from SCHEMA.md B.6.")
		return
	}
	rec.lastSeq = seq
	writeEmpty(w)
}
