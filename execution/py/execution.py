"""Generate and run Python benchmarks using the Go executioner's wire format."""

from __future__ import annotations

import ast
import io
import json
import keyword
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import tokenize
from dataclasses import dataclass, field, replace
from typing import TextIO

from .compiler_options import validate_compiler_flags

BenchTime = 10.0  # Seconds; the wire format uses nanoseconds.
ExecutionTimeout = 120.0  # Per sweep combination, including interpreter startup.
RESULT_PREFIX = "__BENCH_RESULT__:"
MAX_OUTPUT_LINE = 1024 * 1024
MEASUREMENT_FIELDS = (
    "MinTime", "MaxTime", "TotalTime",
    "MajorPageFaultCountMin", "MinorPageFaultCountMin",
    "MajorPageFaultCountMax", "MinorPageFaultCountMax",
    "L1DataMissMin", "L1DataMissMax", "BranchMisssMin", "BranchMissMax",
)


class ExecutionError(RuntimeError):
    """A benchmark failed to compile, run, or return a result."""


@dataclass
class ExecutionConfig:
    BenchDuration: float = 0  # Seconds; zero uses BenchTime.
    Name: str = ""
    ByteCount: int = 0
    Fenced: bool = False
    Imports: str = ""
    Globals: str = ""
    Sweep: str = ""
    Setup: str = ""
    Bench: str = ""
    Cleanup: str = ""
    CompilerFlags: list[str] = field(default_factory=list)


def ParseExecutionConfig(request: dict) -> ExecutionConfig:
    """Split directive blocks while preserving Python comments and indentation."""
    if not isinstance(request, dict):
        raise ValueError("body must contain one JSON object")
    unknown = request.keys() - {"name", "byteCount", "fenced", "code", "compilerFlags"}
    if unknown:
        raise ValueError(f"unknown request field: {sorted(unknown)[0]}")
    name = request.get("name", "")
    byte_count = request.get("byteCount", 0)
    fenced = request.get("fenced", False)
    code = request.get("code", "")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("name is required")
    if type(byte_count) is not int or not 0 <= byte_count <= (1 << 63) - 1:
        raise ValueError("byteCount must be a nonnegative signed 64-bit integer")
    if type(fenced) is not bool:
        raise ValueError("fenced must be a boolean")
    if not isinstance(code, str):
        raise ValueError("code must be a string")
    cfg = ExecutionConfig(Name=name, ByteCount=byte_count, Fenced=fenced, CompilerFlags=validate_compiler_flags(request.get("compilerFlags", [])))
    blocks = {"#" + name.lower(): name for name in
              ("Imports", "Globals", "Sweep", "Setup", "Bench", "Cleanup")}
    code = code.replace("\r\n", "\n")
    # Tokenization prevents a line inside a triple-quoted string from becoming
    # a directive. Only full-line comments can delimit blocks.
    directives = {}
    try:
        for token in tokenize.generate_tokens(io.StringIO(code).readline):
            if (token.type == tokenize.COMMENT and token.string.strip() in blocks
                    and not token.line[:token.start[1]].strip()):
                directives[token.start[0]] = token.string.strip()
    except (tokenize.TokenError, IndentationError):
        # The generated program reports syntax errors with compiler diagnostics.
        pass
    current = None
    seen = set()
    for number, line in enumerate(code.split("\n"), 1):
        if number in directives:
            directive = directives[number]
            if directive in seen:
                raise ValueError(f"line {number}: duplicate directive {directive}")
            seen.add(directive)
            current = blocks[directive]
        elif current is not None:
            setattr(cfg, current, getattr(cfg, current) + line + "\n")
        elif line.strip() and not line.lstrip().startswith("#"):
            raise ValueError(f"line {number}: code must follow a directive")
    if "#bench" not in seen:
        raise ValueError("#bench directive is required")
    return cfg


def BuildSweepMatrix(sweep: str) -> tuple[list[str], list[list[int]]]:
    """Return the Cartesian product in declaration order, as in Go."""
    variables = []
    matrix = [[]]
    for number, line in enumerate(sweep.splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name, separator, values_text = line.partition(":")
        name = name.strip()
        if not separator or not name.isidentifier() or keyword.iskeyword(name) or name.startswith("__bench_"):
            raise ValueError(f"sweep line {number}: expected variable: [integers]")
        if name in variables:
            raise ValueError(f"sweep line {number}: duplicate variable {name!r}")
        try:
            values = json.loads(values_text)
        except ValueError as exc:
            raise ValueError(f"sweep line {number}: invalid integer list") from exc
        if not isinstance(values, list) or any(
            type(v) is not int or not -(1 << 63) <= v < (1 << 63) for v in values
        ):
            raise ValueError(f"sweep line {number}: expected a signed 64-bit integer list")
        variables.append(name)
        matrix = [row + [value] for row in matrix for value in values]
    return variables, matrix


def BuildExecutionSource(cfg: ExecutionConfig) -> str:
    """Render a standalone program. Sweep expansion belongs to RunSweep."""
    if cfg.ByteCount < 0:
        raise ValueError("byte count must be nonnegative")
    if not math.isfinite(cfg.BenchDuration) or cfg.BenchDuration < 0:
        raise ValueError("benchmark duration must be finite and nonnegative")
    duration = cfg.BenchDuration or BenchTime

    try:
        def statements(code):
            return ast.parse(code, filename="<benchmark>").body or [ast.Pass()]

        program = ast.parse(
            "import sys as __bench_sys\n"
            f"__bench_sys.path.insert(0, {str(Path(__file__).resolve().parents[2])!r})\n"
            "from execution.py.execution import _run_profile as __bench_run_profile\n"
        )
        program.body.extend(statements(cfg.Imports))
        program.body.extend(statements(cfg.Globals))
        iteration = ast.parse(
            "def __bench_iteration(__bench_measure):\n"
            "    with __bench_measure:\n"
            "        pass\n"
        ).body[0]
        region = iteration.body[0]
        region.body = statements(cfg.Bench)
        iteration.body = statements(cfg.Setup) + [region] + statements(cfg.Cleanup)
        program.body.append(iteration)
        program.body.extend(statements(
            "if __name__ == '__main__':\n"
            f"    __bench_run_profile({cfg.Name!r}, {cfg.ByteCount!r}, {cfg.Fenced!r}, "
            f"{duration!r}, __bench_iteration)\n"
        ))
        # Structural composition preserves multiline string values when moving
        # user code into nested suites; blindly indenting source changes them.
        source = ast.unparse(ast.fix_missing_locations(program)) + "\n"
        compile(source, "<benchmark>", "exec")
    except SyntaxError as exc:
        raise ExecutionError(f"compile benchmark: {exc}\n{exc.text or ''}") from exc
    return source


def _run_profile(name, byte_count, fenced, duration, iteration) -> None:
    # Imported only in the child: native timers never run in the HTTP process.
    from .profile import GetCPUFreqWait, NewRepProfile

    profile = NewRepProfile(name, byte_count, iteration, duration, GetCPUFreqWait(100))
    result = profile.Start(fenced)
    if not result.Iterations():
        raise ExecutionError("no measurements collected")
    ms_per_tick = 1000 / profile.CPUFreq if profile.CPUFreq else 0
    payload = {
        "name": name, "byte_count": byte_count, "fenced": fenced,
        "timer_frequency": profile.CPUFreq, "run_window_ns": round(duration * 1e9),
        "iterations": result.Iterations(), "total_page_faults": result.TotalPageFaults(),
        "min_time_ms": result.MinTime * ms_per_tick,
        "max_time_ms": result.MaxTime * ms_per_tick,
        "avg_time_ms": result.TotalTime / result.Iterations() * ms_per_tick,
        "measurements": {field: getattr(result, field) for field in MEASUREMENT_FIELDS},
    }
    print("\n" + RESULT_PREFIX + json.dumps(payload, allow_nan=False), flush=True)


def ParseBenchmarkResult(stdout: TextIO) -> dict:
    """Read through EOF, ignoring user logs and requiring exactly one result."""
    result = None
    while line := stdout.readline(MAX_OUTPUT_LINE + 1):
        if len(line) > MAX_OUTPUT_LINE:
            if line.startswith(RESULT_PREFIX):
                raise ExecutionError("benchmark result exceeds 1 MiB")
            # Drain the remainder of an oversized user log line.
            while line and not line.endswith("\n"):
                line = stdout.readline(MAX_OUTPUT_LINE + 1)
            continue
        if not line.startswith(RESULT_PREFIX):
            continue
        if result is not None:
            raise ExecutionError("multiple benchmark results on stdout")
        try:
            result = json.loads(line[len(RESULT_PREFIX):])
        except ValueError as exc:
            raise ExecutionError(f"decode benchmark result: {exc}") from exc
        if not isinstance(result, dict):
            raise ExecutionError("decode benchmark result: expected an object")
    if result is None:
        raise ExecutionError("benchmark result missing from stdout")
    if type(result.get("iterations")) is not int or result["iterations"] <= 0:
        raise ExecutionError("no measurements collected")
    return result


def RunExecution(cfg: ExecutionConfig, timeout: float = ExecutionTimeout) -> dict:
    """Run a fresh interpreter, kill it on timeout, and remove temporary files."""
    flags = validate_compiler_flags(cfg.CompilerFlags)
    source = BuildExecutionSource(cfg)
    with tempfile.TemporaryDirectory(prefix="bench-python-") as directory:
        source_path = Path(directory) / "benchmark.py"
        source_path.write_text(source, encoding="utf-8")
        # Spool user output to disk so verbose benchmarks do not fill RAM.
        with tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace") as stdout, \
                tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace") as stderr:
            try:
                process = subprocess.run(
                    [sys.executable, *flags, "-u", str(source_path)],
                    stdout=stdout, stderr=stderr, timeout=timeout, check=False,
                )
            except subprocess.TimeoutExpired as exc:
                raise TimeoutError(f"benchmark exceeded {timeout:g} seconds") from exc
            except OSError as exc:
                raise ExecutionError(f"start benchmark: {exc}") from exc
            if process.returncode:
                stderr.seek(0, 2)
                stderr.seek(max(0, stderr.tell() - 65536))
                raise ExecutionError(f"run benchmark: exit status {process.returncode}\n{stderr.read()}")
            stdout.seek(0)
            return ParseBenchmarkResult(stdout)


def RunSweep(cfg: ExecutionConfig, timeout: float = ExecutionTimeout) -> list[dict]:
    variables, matrix = BuildSweepMatrix(cfg.Sweep)
    results = []
    for row in matrix:
        assignments = [f"{name}={value}" for name, value in zip(variables, row)]
        run_cfg = replace(
            cfg,
            Name=cfg.Name + (" (" + ", ".join(assignments) + ")" if assignments else ""),
            Setup="".join(f"{assignment}\n" for assignment in assignments) + cfg.Setup,
        )
        try:
            results.append(RunExecution(run_cfg, timeout))
        except TimeoutError as exc:
            raise TimeoutError(f"{run_cfg.Name}: {exc}") from exc
        except (ExecutionError, ValueError) as exc:
            raise ExecutionError(f"{run_cfg.Name}: {exc}") from exc
    return results
