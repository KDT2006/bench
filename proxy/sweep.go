package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// The server reads the #sweep section of benchmark.perf so it can hand the agent the list of
// permutations. The website validates the DSL as the user types (frontend/src/model/sweep.ts);
// this is a straightforward version of the same rules.

const maxPermutations = 200

// SweepParam values are float64 or string.
type SweepParam struct {
	Name   string `json:"name"`
	Values []any  `json:"values"`
}

type Permutation struct {
	Index  int            `json:"index"`
	Params map[string]any `json:"params"`
}

var (
	numberRe = regexp.MustCompile(`^(-?[0-9]+(?:\.[0-9]+)?)\s*([KkMmGg][Ii]?)?[Bb]?$`)
	units    = map[string]float64{"": 1, "k": 1 << 10, "ki": 1 << 10, "m": 1 << 20, "mi": 1 << 20, "g": 1 << 30, "gi": 1 << 30}
)

// parseSweepAll returns the sweep and every error found, for POST /parse.
func parseSweepAll(dsl string) ([]SweepParam, []string) {
	sweep := []SweepParam{}
	var errs []string
	seen := map[string]bool{}
	inSweep := false
	for i, line := range strings.Split(dsl, "\n") {
		line = strings.TrimSpace(line)
		if len(line) > 1 && line[0] == '#' && isWordByte(line[1]) {
			inSweep = line == "#sweep"
			continue
		}
		if !inSweep || line == "" || strings.HasPrefix(line, "//") {
			continue
		}
		name, list, ok := strings.Cut(line, "=")
		name, list = strings.TrimSpace(name), strings.TrimSpace(list)
		if !ok || !validName(name) || seen[name] || !strings.HasPrefix(list, "[") || !strings.HasSuffix(list, "]") {
			errs = append(errs, fmt.Sprintf("Line %d: use a unique parameter name and a list of values.", i+1))
			continue
		}
		values, ok := parseValues(list[1 : len(list)-1])
		if !ok {
			errs = append(errs, fmt.Sprintf("Line %d: enter numbers or double-quoted strings in the list.", i+1))
			continue
		}
		seen[name] = true
		sweep = append(sweep, SweepParam{Name: name, Values: values})
	}
	count := 1
	for _, p := range sweep {
		count = min(count*len(p.Values), maxPermutations+1)
	}
	if count > maxPermutations {
		errs = append(errs, fmt.Sprintf("Reduce the sweep to %d permutations or fewer.", maxPermutations))
	}
	return sweep, errs
}

// parseSweep returns the sweep or its first error.
func parseSweep(dsl string) ([]SweepParam, error) {
	sweep, errs := parseSweepAll(dsl)
	if len(errs) > 0 {
		return nil, errors.New(errs[0])
	}
	return sweep, nil
}

func parseResponse(dsl string) map[string]any {
	sweep, errs := parseSweepAll(dsl)
	count := 0
	if len(errs) == 0 {
		count = len(permutations(sweep))
	}
	if errs == nil {
		errs = []string{}
	}
	return map[string]any{"sweep": sweep, "permutations": count, "errors": errs}
}

// parseValues splits a list at commas outside double quotes and parses each value.
func parseValues(list string) ([]any, bool) {
	var values []any
	var current strings.Builder
	quoted, escaped := false, false
	flush := func() bool {
		v, ok := parseValue(strings.TrimSpace(current.String()))
		current.Reset()
		values = append(values, v)
		return ok
	}
	for _, r := range list {
		switch {
		case escaped:
			escaped = false
		case r == '\\':
			escaped = true
		case r == '"':
			quoted = !quoted
		case r == ',' && !quoted:
			if !flush() {
				return nil, false
			}
			continue
		}
		current.WriteRune(r)
	}
	return values, !quoted && flush()
}

// parseValue reads a quoted string or a number with an optional K/Ki/M/Mi/G/Gi unit and B.
func parseValue(v string) (any, bool) {
	if strings.HasPrefix(v, `"`) {
		var s string
		return s, json.Unmarshal([]byte(v), &s) == nil
	}
	m := numberRe.FindStringSubmatch(v)
	if m == nil {
		return nil, false
	}
	n, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return nil, false
	}
	n *= units[strings.ToLower(m[2])]
	if math.Abs(n) > 1<<53-1 {
		return nil, false
	}
	return n + 0, true // + 0 turns -0 into 0
}

func isWordByte(b byte) bool {
	return b == '_' || b >= '0' && b <= '9' || b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z'
}

func validName(name string) bool {
	if name == "" || name[0] >= '0' && name[0] <= '9' {
		return false
	}
	for i := 0; i < len(name); i++ {
		if !isWordByte(name[i]) {
			return false
		}
	}
	return true
}

// permutations is the cross product of the sweep, first parameter as the outer loop (B.5).
func permutations(sweep []SweepParam) []Permutation {
	combos := []map[string]any{{}}
	for _, p := range sweep {
		var next []map[string]any
		for _, combo := range combos {
			for _, v := range p.Values {
				params := map[string]any{p.Name: v}
				for k, old := range combo {
					params[k] = old
				}
				next = append(next, params)
			}
		}
		combos = next
	}
	out := make([]Permutation, len(combos))
	for i, params := range combos {
		out[i] = Permutation{Index: i + 1, Params: params}
	}
	return out
}
