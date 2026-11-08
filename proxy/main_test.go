package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestProxy(goURL string) http.Handler {
	p := &proxy{backends: map[string]string{"go": goURL}, client: http.DefaultClient, origin: "*"}
	return p.handler()
}

func post(t *testing.T, h http.Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/execute", strings.NewReader(body)))
	return rec
}

const validBody = `{"name":"sort","byteCount":72,"fenced":true,"code":"#bench\nsort.Ints(v)","language":"go","arch":"linux/amd64"}`

func TestExecuteForwardsAndReturnsResult(t *testing.T) {
	var got map[string]any
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("unexpected request %s %s", r.Method, r.Header.Get("Content-Type"))
		}
		data, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(data, &got); err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(localBody))
	}))
	defer local.Close()

	rec := post(t, newTestProxy(local.URL), validBody)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	var resp ExecuteResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil || len(resp.Results) != 1 ||
		resp.Results[0].Name != "sort" || resp.Results[0].Iterations != 4 {
		t.Fatalf("unexpected body %s (%v)", rec.Body, err)
	}
	want := map[string]any{"name": "sort", "byteCount": float64(72), "fenced": true, "code": "#bench\nsort.Ints(v)"}
	if len(got) != len(want) {
		t.Fatalf("local server got %v, want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("local server got %s=%v, want %v", k, got[k], v)
		}
	}
}

// localBody mirrors execution/go BenchmarkResult output: 1 GHz timer, 4 iterations.
const localBody = `{"results":[{"name":"sort","byte_count":1073741824,"fenced":true,"timer_frequency":1000000000,
"run_window_ns":10000000000,"iterations":4,"total_page_faults":6,"min_time_ms":500,"max_time_ms":2000,"avg_time_ms":1000,
"measurements":{"MinTime":500000000,"MaxTime":2000000000,"TotalTime":4000000000,
"MajorPageFaultCountMin":0,"MinorPageFaultCountMin":1,"MajorPageFaultCountMax":1,"MinorPageFaultCountMax":2,
"L1DataMissMin":0,"L1DataMissMax":0,"BranchMisssMin":0,"BranchMissMax":0}}]}`

func TestConvertResponse(t *testing.T) {
	resp, err := convertResponse([]byte(localBody))
	if err != nil {
		t.Fatal(err)
	}
	r := resp.Results[0]
	m := r.Measurements
	if r.ByteCount != 1<<30 || !r.Fenced || r.TimerFrequency != 1e9 || r.RunWindowNanos != 1e10 ||
		r.RunWindowMillis != 10000 || r.TotalPageFaults != 6 || m.NumIterations != 4 || m.TotalPageFaults != 6 {
		t.Fatalf("top-level fields: %+v", r)
	}
	if m.AvgTime != 1e9 || m.PageFaultCountAvg != 1.5 || m.MinorPageFaultCountMax != 2 || m.MajorPageFaultCountMax != 1 {
		t.Fatalf("measurements: %+v", m)
	}
	// 1 GiB in 0.5 s, 2 s and 1 s.
	if m.GigabytesPerSecondMin != 2 || m.GigabytesPerSecondMax != 0.5 || m.GigabytesPerSecondAvg != 1 {
		t.Fatalf("throughput: %+v", m)
	}
	if r.TimeMs != (TimeMs{Min: 500, Max: 2000, Avg: 1000, Total: 4000}) {
		t.Fatalf("timeMs: %+v", r.TimeMs)
	}

	// The JSON keys the website reads.
	data, _ := json.Marshal(resp)
	for _, key := range []string{`"byteCount"`, `"timerFrequency"`, `"runWindowNanos"`, `"runWindowMillis"`, `"iterations"`,
		`"totalPageFaults"`, `"numIterations"`, `"AvgTime"`, `"GigabytesPerSecondAvg"`, `"PageFaultCountAvg"`, `"timeMs"`, `"total"`} {
		if !strings.Contains(string(data), key) {
			t.Errorf("missing %s in %s", key, data)
		}
	}

	// No timer frequency or byte count: derived values stay zero instead of Inf/NaN.
	resp, err = convertResponse([]byte(`{"results":[{"name":"x","iterations":0,"measurements":{}}]}`))
	if err != nil || resp.Results[0].Measurements.GigabytesPerSecondAvg != 0 || resp.Results[0].Measurements.AvgTime != 0 {
		t.Fatalf("zero case: %+v %v", resp, err)
	}
	if _, err := json.Marshal(resp); err != nil {
		t.Fatal(err)
	}

	for _, bad := range []string{`not json`, `{}`, `{"results":{}}`} {
		if _, err := convertResponse([]byte(bad)); err == nil {
			t.Errorf("%s: expected error", bad)
		}
	}
}

func TestExecuteRejectsBadInput(t *testing.T) {
	h := newTestProxy("http://127.0.0.1:1")
	for _, body := range []string{
		`not json`,
		`{"name":"","byteCount":1,"fenced":true,"code":"x","language":"go","arch":"a"}`,
		`{"name":"n","byteCount":-1,"fenced":true,"code":"x","language":"go","arch":"a"}`,
		`{"name":"n","byteCount":1,"fenced":true,"code":" ","language":"go","arch":"a"}`,
		`{"name":"n","byteCount":1,"fenced":true,"code":"x","language":"","arch":"a"}`,
		`{"name":"n","byteCount":1,"fenced":true,"code":"x","language":"go","arch":""}`,
		`{"name":"n","byteCount":1,"fenced":true,"code":"x","language":"rust","arch":"a"}`,
	} {
		if rec := post(t, h, body); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400", body, rec.Code)
		}
	}
}

func TestExecuteLocalServerErrors(t *testing.T) {
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"compile failed"}`, http.StatusInternalServerError)
	}))
	defer local.Close()
	rec := post(t, newTestProxy(local.URL), validBody)
	if rec.Code != http.StatusBadGateway || !strings.Contains(rec.Body.String(), "compile failed") {
		t.Fatalf("status %d body %s", rec.Code, rec.Body)
	}

	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"name":"no results wrapper"}`))
	}))
	defer bad.Close()
	rec = post(t, newTestProxy(bad.URL), validBody)
	if rec.Code != http.StatusBadGateway || !strings.Contains(rec.Body.String(), "unexpected response") {
		t.Fatalf("bad shape: status %d body %s", rec.Code, rec.Body)
	}

	rec = post(t, newTestProxy("http://127.0.0.1:1/execute"), validBody)
	if rec.Code != http.StatusBadGateway || !strings.Contains(rec.Body.String(), "Could not reach") {
		t.Fatalf("unreachable: status %d body %s", rec.Code, rec.Body)
	}
}

func TestHealthAndCORS(t *testing.T) {
	h := newTestProxy("http://127.0.0.1:1")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if rec.Code != http.StatusOK || rec.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("health: %d %v", rec.Code, rec.Header())
	}
	var health Health
	if err := json.Unmarshal(rec.Body.Bytes(), &health); err != nil || health.Status != "ok" ||
		len(health.Languages) != 1 || health.Languages[0] != "go" || health.Arch == "" || health.CPUs < 1 {
		t.Fatalf("health body: %s (%v)", rec.Body, err)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodOptions, "/api/execute", nil))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight: %d", rec.Code)
	}
}
