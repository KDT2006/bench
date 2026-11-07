package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

const token = "secret"

type client struct {
	t   *testing.T
	url string
}

func start(t *testing.T, dataDir string) (*server, client) {
	t.Helper()
	s, err := newServer(token, dataDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.handler("/api"))
	t.Cleanup(ts.Close)
	return s, client{t, ts.URL + "/api"}
}

// do sends a request (agent requests carry the token) and decodes a JSON reply into out.
func (c client) do(method, path string, body any, wantStatus int, out any) {
	c.t.Helper()
	var reader io.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		reader = strings.NewReader(string(data))
	}
	req, _ := http.NewRequest(method, c.url+path, reader)
	if strings.HasPrefix(path, "/agent/") {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != wantStatus {
		c.t.Fatalf("%s %s: status %d, want %d: %s", method, path, resp.StatusCode, wantStatus, data)
	}
	if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			c.t.Fatalf("%s %s: %v: %s", method, path, err, data)
		}
	}
}

func (c client) register(id string) {
	c.t.Helper()
	c.do("POST", "/agent/register", map[string]any{
		"agentVersion": "0.1.0",
		"machine":      map[string]any{"id": id, "arch": "x86_64", "cpuModel": "Test CPU"},
		"capabilities": map[string]any{"languages": []string{"go", "python"}},
	}, 200, nil)
}

func (c client) poll(machineID, status string, jobID any) (resp struct {
	Job    *Job `json:"job"`
	Cancel bool `json:"cancel"`
}) {
	c.t.Helper()
	c.do("POST", "/agent/poll", map[string]any{"machineId": machineID, "status": status, "jobId": jobID}, 200, &resp)
	return resp
}

func (c client) event(jobID string, seq int, event map[string]any, wantStatus int) {
	c.t.Helper()
	event["seq"] = seq
	event["sentAt"] = "2025-01-15T12:00:00.000Z"
	c.do("POST", "/agent/jobs/"+jobID+"/events", event, wantStatus, nil)
}

func workspace(dsl string) map[string]any {
	return map[string]any{
		"title": "Array sum", "linkDsl": true, "createdAt": "c", "updatedAt": "u",
		"lanes": []any{map[string]any{
			"id": "lane-a", "label": "A", "color": "#E6A23C", "language": "go", "arch": "x86_64", "mode": "scaffold",
			"files":  map[string]any{"benchmark.perf": dsl, "harness.go": "package main"},
			"build":  map[string]any{"toolchainVersion": "go1.23", "flags": []any{}, "env": map[string]any{}},
			"runner": map[string]any{"warmup": 5, "maxReps": 120, "counters": []any{"cycles", "time"}},
		}},
	}
}

func stat(v float64) map[string]any {
	return map[string]any{"min": v, "median": v, "mean": v, "p95": v, "stddev": 0}
}

// readEvents reads an SSE stream until it closes.
func readEvents(t *testing.T, url string) []map[string]any {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var events []map[string]any
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		if data, ok := strings.CutPrefix(scanner.Text(), "data: "); ok {
			var event map[string]any
			_ = json.Unmarshal([]byte(data), &event)
			events = append(events, event)
		}
	}
	return events
}

func TestFullRun(t *testing.T) {
	_, c := start(t, "")
	c.register("m1")

	var machines []map[string]any
	c.do("GET", "/machines", nil, 200, &machines)
	if len(machines) != 1 || machines[0]["status"] != "idle" || machines[0]["cpuModel"] != "Test CPU" {
		t.Fatalf("machines = %v", machines)
	}

	var started struct{ RunID string }
	c.do("POST", "/runs", map[string]any{"workspace": workspace("#sweep\nN = [1Ki, 2Ki]\nkind = [\"a,b\"]\n")}, 202, &started)

	job := c.poll("m1", "idle", nil).Job
	if job == nil || job.RunID != started.RunID || len(job.Permutations) != 2 {
		t.Fatalf("job = %+v", job)
	}
	if got := job.Permutations[1].Params; !reflect.DeepEqual(got, map[string]any{"N": 2048.0, "kind": "a,b"}) {
		t.Fatalf("params = %v", got)
	}
	if again := c.poll("m1", "busy", job.JobID); again.Job != nil || again.Cancel {
		t.Fatalf("second poll = %+v", again)
	}

	id := job.JobID
	c.event(id, 1, map[string]any{"type": "job.accepted"}, 204)
	c.event(id, 2, map[string]any{"type": "build.start", "laneId": "lane-a"}, 204)
	c.event(id, 3, map[string]any{"type": "build.done", "laneId": "lane-a", "ok": true, "log": "", "toolchain": "go1.23.4"}, 204)
	c.event(id, 4, map[string]any{"type": "perm.start", "laneId": "lane-a", "index": 1, "total": 2, "params": map[string]any{"N": 1024, "kind": "a,b"}}, 204)
	result := map[string]any{
		"type": "perm.result", "laneId": "lane-a", "index": 1, "params": map[string]any{"N": 1024, "kind": "a,b"},
		"reps": 120, "warmupReps": 5, "windowMs": 1000, "fenced": true, "byteCount": nil,
		"metrics":          map[string]any{"cycles": stat(880), "timeNs": stat(230), "pageFaults": stat(0), "cacheMisses": nil},
		"samples":          []any{884, 862},
		"samplesTruncated": false,
	}
	c.event(id, 5, result, 204)
	c.event(id, 5, result, 204) // a retry is ignored
	c.event(id, 6, map[string]any{"type": "job.finished", "status": "done"}, 204)
	c.event(id, 7, map[string]any{"type": "log", "laneId": "lane-a", "stream": "stderr", "text": "late"}, 409)

	var run Run
	c.do("GET", "/runs/"+started.RunID, nil, 200, &run)
	if run.Status != "done" || run.FinishedAt == "" || len(run.Rows) != 1 {
		t.Fatalf("run = %+v", run)
	}
	row := run.Rows[0].(map[string]any)
	if metrics := row["metrics"].(map[string]any); len(metrics) != 2 || metrics["timeNs"] == nil {
		t.Fatalf("metrics should be only cycles and timeNs: %v", metrics)
	}

	var types []string
	for _, event := range readEvents(t, c.url+"/runs/"+started.RunID+"/events") {
		types = append(types, event["type"].(string))
	}
	want := []string{"queued", "build_start", "build_done", "perm_start", "result", "done"}
	if !reflect.DeepEqual(types, want) {
		t.Fatalf("events = %v, want %v", types, want)
	}
}

func TestCancel(t *testing.T) {
	_, c := start(t, "")
	c.register("m1")
	ws := map[string]any{"workspace": workspace("#sweep\nN = [1]\n")}

	// Queued: cancelled by the server alone.
	var first, second struct{ RunID string }
	c.do("POST", "/runs", ws, 202, &first)
	c.do("POST", "/runs", ws, 202, &second)
	c.do("POST", "/runs/"+first.RunID+"/cancel", nil, 204, nil)
	var run Run
	c.do("GET", "/runs/"+first.RunID, nil, 200, &run)
	if run.Status != "cancelled" {
		t.Fatalf("status = %s", run.Status)
	}

	// Running: the agent is told on its next poll.
	job := c.poll("m1", "idle", nil).Job
	if job == nil || job.RunID != second.RunID {
		t.Fatalf("job = %+v", job)
	}
	c.event(job.JobID, 1, map[string]any{"type": "job.accepted"}, 204)
	c.do("POST", "/runs/"+second.RunID+"/cancel", nil, 204, nil)
	if !c.poll("m1", "busy", job.JobID).Cancel {
		t.Fatal("poll should say cancel")
	}
	c.event(job.JobID, 2, map[string]any{"type": "job.finished", "status": "cancelled"}, 204)
	c.do("GET", "/runs/"+second.RunID, nil, 200, &run)
	if run.Status != "cancelled" {
		t.Fatalf("status = %s", run.Status)
	}
	// A finished stream answers 204 so EventSource stops reconnecting.
	req, _ := http.NewRequest("GET", c.url+"/runs/"+second.RunID+"/events", nil)
	req.Header.Set("Last-Event-ID", "99")
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 204 {
		t.Fatalf("events after end: %v %v", resp.StatusCode, err)
	}
}

func TestLostJobAndOffline(t *testing.T) {
	s, c := start(t, "")
	c.register("m1")
	var started struct{ RunID string }
	c.do("POST", "/runs", map[string]any{"workspace": workspace("")}, 202, &started)
	if c.poll("m1", "idle", nil).Job == nil {
		t.Fatal("no job")
	}
	for range missedPollLimit {
		c.poll("m1", "idle", nil)
	}
	var run Run
	c.do("GET", "/runs/"+started.RunID, nil, 200, &run)
	if run.Status != "failed" {
		t.Fatalf("lost job: status = %s", run.Status)
	}

	c.do("POST", "/runs", map[string]any{"workspace": workspace("")}, 202, &started)
	c.poll("m1", "idle", nil)
	s.mu.Lock()
	s.machines["m1"].lastSeen = time.Now().Add(-time.Minute)
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	s.watchMachines(ctx)
	c.do("GET", "/runs/"+started.RunID, nil, 200, &run)
	if run.Status != "failed" {
		t.Fatalf("offline: status = %s", run.Status)
	}
}

func TestStartRunErrors(t *testing.T) {
	_, c := start(t, "")
	c.do("POST", "/runs", map[string]any{"workspace": workspace("")}, 503, nil)
	c.register("m1")
	c.do("POST", "/runs", map[string]any{"workspace": workspace("#sweep\nN = [1, x]\n")}, 422, nil)
	c.do("POST", "/runs", map[string]any{"workspace": workspace("#sweep\nA = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]\nB = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]\n")}, 422, nil)
	noHarness := workspace("")
	delete(noHarness["lanes"].([]any)[0].(map[string]any)["files"].(map[string]any), "harness.go")
	c.do("POST", "/runs", map[string]any{"workspace": noHarness}, 400, nil)
	c.do("POST", "/runs", map[string]any{"workspace": map[string]any{"lanes": []any{}}}, 400, nil)
	c.do("POST", "/agent/poll", nil, 400, nil)
	req, _ := http.NewRequest("POST", c.url+"/agent/poll", nil)
	if resp, _ := http.DefaultClient.Do(req); resp.StatusCode != 401 {
		t.Fatalf("no token: %d", resp.StatusCode)
	}
	big := strings.Repeat("x", bodyLimit+1)
	c.do("POST", "/benches", map[string]any{"title": big}, 413, nil)
}

func TestBenchesSharesAndRestart(t *testing.T) {
	dir := t.TempDir()
	_, c := start(t, dir)
	var bench map[string]any
	c.do("POST", "/benches", workspace(""), 201, &bench)
	id := bench["id"].(string)
	ws := workspace("")
	ws["title"] = "Renamed"
	ws["createdAt"] = "ignored"
	c.do("PUT", "/benches/"+id, ws, 200, &bench)
	if bench["title"] != "Renamed" || bench["createdAt"] != "c" {
		t.Fatalf("bench = %v", bench)
	}
	var share struct{ ShareID string }
	c.do("POST", "/share", map[string]any{"workspace": ws, "runId": "sample-array-sum"}, 201, &share)
	c.do("POST", "/share", map[string]any{"workspace": ws, "runId": "nope"}, 404, nil)

	// A new server on the same directory sees the bench and the share.
	_, c2 := start(t, dir)
	var list []map[string]any
	c2.do("GET", "/benches", nil, 200, &list)
	if len(list) != 1 || list[0]["title"] != "Renamed" {
		t.Fatalf("benches = %v", list)
	}
	var snapshot map[string]any
	c2.do("GET", "/share/"+share.ShareID, nil, 200, &snapshot)
	if snapshot["runId"] != "sample-array-sum" {
		t.Fatalf("share = %v", snapshot)
	}
	c2.do("DELETE", "/benches/"+id, nil, 204, nil)
	c2.do("GET", "/benches/"+id, nil, 404, nil)

	var examples []map[string]any
	c2.do("GET", "/examples", nil, 200, &examples)
	if len(examples) != 6 {
		t.Fatalf("examples = %d", len(examples))
	}
	var sample Run
	c2.do("GET", "/runs/sample-array-sum", nil, 200, &sample)
	if sample.Status != "done" || len(sample.Rows) == 0 {
		t.Fatalf("sample = %+v", sample.Status)
	}
}

func TestParseSweep(t *testing.T) {
	sweep, err := parseSweep("#setup\nx = [1]\n#sweep\n// note\nN = [1Ki, 2MiB, -0, 1.5]\nname = [\"a\\\"b\", \"c,d\"]\n#bench\n")
	if err != nil {
		t.Fatal(err)
	}
	want := []SweepParam{
		{Name: "N", Values: []any{1024.0, 2097152.0, 0.0, 1.5}},
		{Name: "name", Values: []any{`a"b`, "c,d"}},
	}
	if !reflect.DeepEqual(sweep, want) {
		t.Fatalf("sweep = %v", sweep)
	}
	for _, bad := range []string{"N = []", "N = [1,]", "1N = [1]", "N = [1]\nN = [2]", "N = [\"open]", "N = [1e3]", "N = [1KB2]"} {
		if _, err := parseSweep("#sweep\n" + bad); err == nil {
			t.Errorf("%q: want an error", bad)
		}
	}
	if got := len(permutations(nil)); got != 1 {
		t.Fatalf("empty sweep permutations = %d", got)
	}
}
