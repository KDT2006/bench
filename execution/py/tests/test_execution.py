import io
import json
from pathlib import Path
import tempfile
import unittest
from dataclasses import replace

from execution.py.execution import (
    BenchTime, BuildExecutionSource, BuildSweepMatrix, ExecutionConfig,
    ExecutionError, MEASUREMENT_FIELDS, ParseBenchmarkResult, ParseExecutionConfig,
    RunExecution, RunSweep,
)


class ExecutionTests(unittest.TestCase):
    def test_directives_preserve_python_comments_strings_and_indentation(self):
        cfg = ParseExecutionConfig({
            "name": "example", "byteCount": 8, "fenced": True,
            "code": '# comment\r\n#imports\r\nimport math\r\n#globals\r\ns = """\r\n#bench\r\n"""\r\n'
                    '#sweep\r\nn: [1, 2]\r\n#setup\r\nvalues = []\r\n#bench\r\n'
                    '# ordinary comment\r\nfor i in range(n):\r\n    values.append(i)\r\n'
                    '#cleanup\r\nassert len(values) == n',
        })
        self.assertEqual((cfg.Name, cfg.ByteCount, cfg.Fenced), ("example", 8, True))
        self.assertEqual(cfg.Imports, "import math\n")
        self.assertEqual(cfg.Globals, 's = """\n#bench\n"""\n')
        self.assertEqual(cfg.Bench, "# ordinary comment\nfor i in range(n):\n    values.append(i)\n")
        self.assertEqual(cfg.Cleanup, "assert len(values) == n\n")
        BuildExecutionSource(cfg)

    def test_invalid_requests(self):
        for request in [None, [], {}, {"name": "  "}, {"name": "x", "code": "#setup"},
                        {"name": "x", "code": "x = 1\n#bench"},
                        {"name": "x", "code": "#bench\n#bench"}]:
            with self.subTest(request=request), self.assertRaises(ValueError):
                ParseExecutionConfig(request)
        for field, value in [("byteCount", -1), ("byteCount", True), ("byteCount", 1.5),
                             ("byteCount", 1 << 63), ("code", None), ("fenced", "false"),
                             ("name", 2), ("extra", 1)]:
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                ParseExecutionConfig({"name": "x", "code": "#bench", field: value})

    def test_sweep_matrix(self):
        self.assertEqual(BuildSweepMatrix("a: [10, 20]\nb: [50, 100]"),
                         (["a", "b"], [[10, 50], [10, 100], [20, 50], [20, 100]]))
        self.assertEqual(BuildSweepMatrix(""), ([], [[]]))
        self.assertEqual(BuildSweepMatrix("a: [1]\nb: []"), (["a", "b"], []))
        self.assertEqual(BuildSweepMatrix("\n a : [-1, 2]\n"), (["a"], [[-1], [2]]))
        for sweep in ["a [1]", ": [1]", "a: 1", "a: [bad]", "a: [1]\na: [2]",
                      "a: [true]", "a: [1.0]", "a: [null]", "for: [1]", "x.y: [1]",
                      "__bench_measure: [1]", "a: [9223372036854775808]"]:
            with self.subTest(sweep=sweep), self.assertRaises(ValueError):
                BuildSweepMatrix(sweep)

    def test_real_execution_and_wire_schema(self):
        for fenced in (False, True):
            with self.subTest(fenced=fenced):
                cfg = ExecutionConfig(
                    Name='sort "example"\nbenchmark', ByteCount=24, Fenced=fenced,
                    BenchDuration=0.01, Imports="import math",
                    Globals="sink = []", Setup="values = [3, 1, 2]",
                    Bench="values.sort()\nanswer = sum(values)\nsink[:] = values",
                    Cleanup="assert values == [1, 2, 3]\nassert sink == values\nassert answer == 6",
                )
                result = RunExecution(cfg)
                self.assertEqual(set(result), {"name", "byte_count", "fenced", "timer_frequency",
                    "run_window_ns", "iterations", "total_page_faults", "min_time_ms",
                    "max_time_ms", "avg_time_ms", "measurements"})
                self.assertEqual((result["name"], result["byte_count"], result["fenced"]),
                                 (cfg.Name, 24, fenced))
                self.assertEqual(result["run_window_ns"], 10_000_000)
                self.assertGreater(result["iterations"], 0)
                self.assertGreater(result["timer_frequency"], 0)
                m = result["measurements"]
                self.assertEqual(set(m), set(MEASUREMENT_FIELDS))
                self.assertGreater(m["TotalTime"], 0)
                self.assertLessEqual(m["MinTime"], m["TotalTime"] / result["iterations"])
                self.assertLessEqual(m["TotalTime"] / result["iterations"], m["MaxTime"])
                for counter_field in ("L1DataMissMin", "L1DataMissMax", "BranchMisssMin", "BranchMissMax"):
                    self.assertGreaterEqual(m[counter_field], 0)
                ms = 1000 / result["timer_frequency"]
                self.assertEqual(result["min_time_ms"], m["MinTime"] * ms)
                self.assertEqual(result["max_time_ms"], m["MaxTime"] * ms)
                self.assertEqual(result["avg_time_ms"], m["TotalTime"] / result["iterations"] * ms)

    def test_setup_is_fresh_and_globals_run_once_per_process(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "lifecycle.txt"
            cfg = ExecutionConfig(
                Name="lifecycle", BenchDuration=0.01,
                Imports="from pathlib import Path",
                Globals=f"path = Path({str(path)!r})\npath.write_text('global\\n')\ncount = 0",
                Setup="global count\nvalues = []\ncount += 1",
                Bench="assert not values\nvalues.append(count)",
                Cleanup="assert values == [count]\nwith path.open('a') as f:\n    f.write('iteration\\n')",
            )
            result = RunExecution(cfg)
            self.assertEqual(path.read_text().splitlines(), ["global"] + ["iteration"] * result["iterations"])

    def test_multiline_string_values_survive_source_generation(self):
        cfg = ParseExecutionConfig({"name": "strings", "code":
            '#setup\ntext = """first\n#bench\nlast"""\n'
            '#bench\nresult = f"""{text}\nend"""\n'
            '#cleanup\nassert result == "first\\n#bench\\nlast\\nend"'})
        result = RunExecution(replace(cfg, BenchDuration=0.005))
        self.assertGreater(result["iterations"], 0)

    def test_real_sweep_has_fresh_process_for_each_combination(self):
        cfg = ExecutionConfig(Name="sweep", BenchDuration=0.005,
            Sweep="a: [1, 2]\nb: [3, 4]", Globals="seen = set()",
            Setup="assert not seen or seen == {(a, b)}",
            Bench="seen.add((a, b))", Cleanup="assert len(seen) == 1")
        results = RunSweep(cfg)
        self.assertEqual([r["name"] for r in results],
                         ["sweep (a=1, b=3)", "sweep (a=1, b=4)", "sweep (a=2, b=3)", "sweep (a=2, b=4)"])
        self.assertEqual(RunSweep(replace(cfg, Sweep="a: []")), [])

    def test_user_stdout_and_result_errors(self):
        result = RunExecution(ExecutionConfig(BenchDuration=0.001, Globals="print('user log', end='')"))
        self.assertGreater(result["iterations"], 0)
        wire = '__BENCH_RESULT__:' + json.dumps(result) + '\n'
        self.assertEqual(ParseBenchmarkResult(io.StringIO('log\n' + wire + 'more log\n')), result)
        for stdout in ["log only", "__BENCH_RESULT__:{bad json}\n", "__BENCH_RESULT__:{}\n",
                       "__BENCH_RESULT__:[]\n", "__BENCH_RESULT__:null\n", wire + wire,
                       "x" * (1024 * 1024 + 1)]:
            with self.subTest(stdout=stdout[:60]), self.assertRaises(ExecutionError):
                ParseBenchmarkResult(io.StringIO(stdout))

    def test_failures_include_diagnostics(self):
        for field in ("Globals", "Setup", "Bench", "Cleanup"):
            with self.subTest(field=field), self.assertRaisesRegex(ExecutionError, "work failed"):
                RunExecution(ExecutionConfig(BenchDuration=0.01, **{field: "raise RuntimeError('work failed')"}))
        with self.assertRaisesRegex(ExecutionError, "compile benchmark"):
            RunExecution(ExecutionConfig(Bench="invalid python code"))
        with self.assertRaisesRegex(ExecutionError, "missing from stdout"):
            RunExecution(ExecutionConfig(Globals="raise SystemExit(0)"))
        with self.assertRaisesRegex(TimeoutError, "exceeded"):
            RunExecution(ExecutionConfig(Globals="while True: pass"), timeout=0.1)

    def test_duration_validation_and_default(self):
        source = BuildExecutionSource(ExecutionConfig())
        self.assertIn(f", {BenchTime!r}, __bench_iteration)", source)
        for duration in (-1, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                BuildExecutionSource(ExecutionConfig(BenchDuration=duration))
        with self.assertRaises(ValueError):
            BuildExecutionSource(ExecutionConfig(ByteCount=-1))


if __name__ == "__main__":
    unittest.main()

class CompilerOptionsTests(unittest.TestCase):
    def test_options_affect_the_actual_child_interpreter(self):
        for flags, level in [([], 0), (["-O"], 1), (["-OO", "-B", "-X", "dev"], 2)]:
            with self.subTest(flags=flags):
                cfg = ParseExecutionConfig({"name": "options", "compilerFlags": flags,
                    "code": f'#imports\nimport sys\n#globals\ndef example():\n    "A docstring"\n'
                            f'if sys.flags.optimize != {level}:\n    raise RuntimeError("options not applied")\n'
                            f'if {level} == 2 and example.__doc__ is not None:\n    raise RuntimeError("docstrings kept")\n#bench\npass'})
                result = RunExecution(replace(cfg, BenchDuration=0.005))
                self.assertGreater(result["iterations"], 0)

    def test_options_validate_types_and_preserve_entrypoint(self):
        for flags in ["-O", None, [1], [""], ["-c", "print(1)"], ["-m", "timeit"],
                      ["-i"], ["-X"], ["-W", "-O"], ["-O\0"], ["-O"] * 65]:
            with self.subTest(flags=flags), self.assertRaises(ValueError):
                ParseExecutionConfig({"name": "x", "code": "#bench", "compilerFlags": flags})
