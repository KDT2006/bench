package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseExecutionConfig(t *testing.T) {
	cfg, err := ParseExecutionConfig(ExecutionRequest{
		Name: "example", ByteCount: 8, Fenced: true,
		Code: "#imports\r\n\"sort\"\r\n#globals\r\nvar sink []int\r\n#sweep\r\nn: [1, 2]\r\n#setup\r\nvalues := make([]int, n)\r\n#bench\r\nsort.Ints(values)\r\nsink = values\r\n#cleanup\r\nsink = nil",
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Name != "example" || cfg.ByteCount != 8 || !cfg.Fenced ||
		cfg.Imports != "\"sort\"\n" || cfg.Globals != "var sink []int\n" ||
		cfg.Sweep != "n: [1, 2]\n" || cfg.Setup != "values := make([]int, n)\n" ||
		cfg.Bench != "sort.Ints(values)\nsink = values\n" || cfg.Cleanup != "sink = nil\n" {
		t.Fatalf("unexpected config: %+v", cfg)
	}
	for _, request := range []ExecutionRequest{
		{Name: "example", Code: "#setup\nx := 1"},
		{Name: "example", Code: "#unknown\n#bench"},
		{Name: "example", Code: "#bench\n#bench"},
		{Name: "example", Code: "x := 1\n#bench"},
		{Name: "example", ByteCount: -1, Code: "#bench"},
		{Code: "#bench"},
	} {
		if _, err := ParseExecutionConfig(request); err == nil {
			t.Errorf("expected invalid request: %+v", request)
		}
	}
}

func TestHandleExecutionRejectsInvalidRequests(t *testing.T) {
	for _, tc := range []struct {
		method, body string
		status       int
	}{
		{http.MethodGet, "", http.StatusMethodNotAllowed},
		{http.MethodPost, "{", http.StatusBadRequest},
		{http.MethodPost, `{"name":"test","code":"#bench","extra":1}`, http.StatusBadRequest},
		{http.MethodPost, `{"name":"test","code":"#bench"} {}`, http.StatusBadRequest},
		{http.MethodPost, `{"name":"test","code":"#setup"}`, http.StatusBadRequest},
		{http.MethodPost, `{"name":"test","code":"#globals\nfunc MOVAllBytesASM(count uint64, data *byte)\n#bench\nMOVAllBytesASM(0, nil)"}`, http.StatusBadRequest},
		{http.MethodPost, `{"name":"test","code":"#sweep\nn: [bad]\n#bench"}`, http.StatusBadRequest},
	} {
		request := httptest.NewRequest(tc.method, "/execute", strings.NewReader(tc.body))
		response := httptest.NewRecorder()
		handleExecution(response, request)
		if response.Code != tc.status {
			t.Errorf("%s %q: got %d, want %d: %s", tc.method, tc.body, response.Code, tc.status, response.Body.String())
		}
	}
}

func TestHandleExecutionReturnsResults(t *testing.T) {
	if testing.Short() {
		t.Skip("HTTP execution uses the default ten-second profiling window")
	}
	request := httptest.NewRequest(http.MethodPost, "/execute", strings.NewReader(
		`{"name":"HTTP example","byteCount":8,"fenced":true,"code":"#globals\nvar sink int\n#setup\nvalue := 10\n#bench\nsink = value + 1\n#cleanup\nif sink != 11 { panic(\"unexpected result\") }"}`))
	response := httptest.NewRecorder()
	handleExecution(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	var payload struct {
		Results []BenchmarkResult `json:"results"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Results) != 1 {
		t.Fatalf("expected one result, got %+v", payload)
	}
	r := payload.Results[0]
	if r.Name != "HTTP example" || r.ByteCount != 8 || !r.Fenced || r.Iterations <= 0 || r.TimerFrequency == 0 || r.Measurements.TotalTime == 0 {
		t.Fatalf("unexpected result: %+v", r)
	}
}
