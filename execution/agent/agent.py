"""Loopback agent for the checked-in Array sum benchmark."""
import argparse
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import platform
import runpy
import shutil
import socket
import statistics
import subprocess
import sys
import tempfile
import threading
from datetime import datetime, timezone
from time import perf_counter_ns, sleep
from urllib.parse import urlsplit


HERE = Path(__file__).resolve().parent
FIXTURE = HERE.parents[1] / "frontend/mock/fixtures/run.json"
HARNESS = {"go": "harness.go", "python": "harness.py"}
MAX_BYTES = 64 * 1024 * 1024
MAX_COMBINATIONS = 256
TIMER = {"source": "perf_counter_ns", "freqHz": 10**9, "calibrated": False}


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class Cancelled(Exception):
    pass


class AgentAPI:
    def __init__(self, url, token):
        self.url = url
        self.token = token

    def post(self, path, payload, retry=True):
        body = json.dumps(payload)
        for attempt in range(5 if retry else 1):
            conn = http.client.HTTPConnection(self.url.hostname, self.url.port, timeout=3)
            try:
                conn.request("POST", self.url.path.rstrip("/") + path, body, {
                    "Content-Type": "application/json", "Authorization": f"Bearer {self.token}",
                })
                response = conn.getresponse()
                data = response.read()
                if response.status in (200, 204):
                    return json.loads(data) if data else None
                raise ApiError(response.status, f"{path}: HTTP {response.status}")
            except (OSError, http.client.HTTPException, ApiError) as exc:
                if not retry or attempt == 4 or isinstance(exc, ApiError) and exc.status < 500:
                    raise
                sleep(1)
            finally:
                conn.close()


def measure_python(file, warmup, reps, window):
    arr = bytearray(sys.stdin.buffer.read())
    benchmark = runpy.run_path(file)["benchmark"]
    for _ in range(warmup):
        benchmark(arr)
    samples = []
    deadline = perf_counter_ns() + window * 10**6
    for _ in range(reps):
        start = perf_counter_ns()
        benchmark(arr)
        samples.append(perf_counter_ns() - start)
        if perf_counter_ns() >= deadline:
            break
    print(json.dumps(samples))


def run_process(command, cancel, stdin=subprocess.DEVNULL, **kwargs):
    with subprocess.Popen(command, stdin=stdin,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs) as child:
        deadline = perf_counter_ns() + 60 * 10**9
        try:
            while not cancel.is_set():
                try:
                    output, errors = child.communicate(timeout=0.2)
                    if cancel.is_set():
                        raise Cancelled
                    if child.returncode:
                        raise RuntimeError(errors[-16000:].decode(errors="replace").strip()
                                           or f"Process exited with status {child.returncode}.")
                    return output
                except subprocess.TimeoutExpired:
                    if perf_counter_ns() >= deadline:
                        raise RuntimeError("Process exceeded the 60-second limit.")
            raise Cancelled
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate()


def options(lane):
    runner = lane.get("runner") or {}
    if not isinstance(runner, dict) or runner.get("core") is not None or runner.get("memLimitMb") is not None:
        raise ValueError("This local runner does not support core pinning or custom memory limits.")
    build = lane.get("build") or {}
    if not isinstance(build, dict) or any(build.get(key) for key in ("flags", "env", "asmFlags")):
        raise ValueError("This local runner uses the installed toolchains and default build settings.")
    limits = (("warmup", 0, 0, 5), ("maxReps", 120, 1, 120), ("minTimeMs", 1000, 1, 1000))
    values = tuple(runner.get(key, default) for key, default, _, _ in limits)
    if any(type(value) is not int or not low <= value <= high
           for value, (_, _, low, high) in zip(values, limits)):
        raise ValueError("Use 0–5 warmups, 1–120 repetitions, and a 1–1000 ms window.")
    return values


def validate(job, trusted, arch):
    for lane in job["lanes"]:
        language = lane["language"]
        filename = HARNESS.get(language)
        files = lane["files"]
        if (lane["arch"] != arch or not filename or set(files) != {"benchmark.perf", filename}
                or files[filename] != trusted[language][filename]
                or body(files["benchmark.perf"]) != body(trusted[language]["benchmark.perf"])):
            raise ValueError("This runner only measures the built-in Array sum. Choose Load live Array sum.")
        options(lane)
    permutations = job["permutations"]
    if not 1 <= len(permutations) <= MAX_COMBINATIONS or any(
        set(perm["params"]) != {"N"} or type(perm["params"]["N"]) is not int
        or not 1 <= perm["params"]["N"] <= MAX_BYTES for perm in permutations
    ):
        raise ValueError(f"Array sum accepts up to {MAX_COMBINATIONS} positive N sizes, each at most 64 MiB.")


def body(dsl):
    return dsl.partition("#setup\n")[2].strip()


def stats(samples):
    ordered = sorted(samples)
    index = (len(ordered) - 1) * 0.95
    low, high = math.floor(index), math.ceil(index)
    return {
        "min": ordered[0], "median": statistics.median(ordered), "mean": statistics.mean(ordered),
        "p95": ordered[low] + (ordered[high] - ordered[low]) * (index - low),
        "stddev": statistics.stdev(ordered) if len(ordered) > 1 else 0,
    }


def run_job(api, job, cancel, trusted, machine):
    seq = 0

    def event(kind, **fields):
        nonlocal seq
        seq += 1
        api.post(f'/agent/jobs/{job["jobId"]}/events', {
            "seq": seq, "sentAt": datetime.now(timezone.utc).isoformat(), "type": kind, **fields,
        })

    lane_id = None
    try:
        try:
            validate(job, trusted, machine["arch"])
        except ValueError as exc:
            event("job.rejected", reason="invalid_job", message=str(exc))
            return
        event("job.accepted")
        with tempfile.TemporaryDirectory(prefix="benchscope-") as directory:
            root = Path(directory)
            commands = {}
            for lane in job["lanes"]:
                lane_id, language = lane["id"], lane["language"]
                event("build.start", laneId=lane_id)
                try:
                    if language not in commands:
                        filename = HARNESS[language]
                        (root / filename).write_text(trusted[language][filename], encoding="utf-8")
                        if language == "go":
                            shutil.copyfile(HERE / "measure.go", root / "measure.go")
                            run_process(["go", "build", "-o", "measure", "measure.go", filename], cancel,
                                        cwd=root, env={**os.environ, "GOTOOLCHAIN": "local", "CGO_ENABLED": "0",
                                             "GOENV": "off", "GOFLAGS": ""})
                            commands[language] = [str(root / "measure")]
                        else:
                            commands[language] = [sys.executable, "-I", str(Path(__file__).resolve()),
                                                  "--measure", str(root / filename)]
                except (OSError, RuntimeError) as exc:
                    event("build.done", laneId=lane_id, ok=False, log=str(exc), toolchain=machine["toolchains"][language])
                    event("job.finished", status="failed", laneId=lane_id, message="build_failed: " + str(exc))
                    return
                event("build.done", laneId=lane_id, ok=True, log="", toolchain=machine["toolchains"][language])
            for perm in job["permutations"]:
                n = perm["params"]["N"]
                # Generate one deterministic pseudorandom input for both languages outside timing.
                input_file = root / "input.bin"
                input_file.write_bytes(hashlib.shake_256(b"benchscope array sum").digest(n))
                for lane in job["lanes"]:
                    lane_id = lane["id"]
                    if cancel.is_set():
                        raise Cancelled
                    event("perm.start", laneId=lane_id, index=perm["index"],
                          total=len(job["permutations"]), params=perm["params"])
                    warmup, reps, window = options(lane)
                    command = commands[lane["language"]] + [str(warmup), str(reps), str(window)]
                    with input_file.open("rb") as data:
                        samples = json.loads(run_process(command, cancel, stdin=data))
                    throughput = [n * 10**9 / (sample * 1024**3) for sample in samples if sample > 0]
                    event("perm.result", laneId=lane_id, index=perm["index"], params=perm["params"],
                          reps=len(samples), warmupReps=warmup, windowMs=window, fenced=False,
                          timer=TIMER, byteCount=n,
                          metrics={"timeNs": stats(samples), "throughput": stats(throughput) if throughput else None},
                          samples=[], samplesTruncated=False)
        event("job.finished", status="cancelled" if cancel.is_set() else "done")
    except Cancelled:
        event("job.finished", status="cancelled")
    except (ApiError, OSError, RuntimeError, ValueError) as exc:
        if isinstance(exc, ApiError) and exc.status in (404, 409):
            return
        event("job.finished", status="failed", laneId=lane_id, message="internal: " + str(exc))


def machine_snapshot():
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x86_64"}.get(platform.machine())
    if not arch or platform.system() not in {"Darwin", "Linux"}:
        raise SystemExit("The local agent needs macOS or Linux on arm64 or x86_64.")

    def sysctl(name):
        return subprocess.run(["sysctl", "-n", name], capture_output=True, text=True).stdout.strip()

    threads = os.cpu_count() or 1
    if platform.system() == "Darwin":
        cpu = sysctl("machdep.cpu.brand_string") or platform.machine()
        cores = int(sysctl("hw.physicalcpu") or threads)
        ram = int(sysctl("hw.memsize") or 0)
    else:
        cpu, cores = platform.machine(), threads
        ram = os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
    go = subprocess.check_output(["go", "version"], text=True, env={**os.environ, "GOTOOLCHAIN": "local"}).split()[2]
    return {
        "id": f"array-sum-{socket.gethostname()}-{arch}", "arch": arch,
        "cpuModel": cpu, "cores": cores, "threads": threads, "smt": cores < threads,
        "baseMhz": 0, "boostMhz": 0, "governor": "Unknown", "turbo": False,
        "caches": [], "ramBytes": ram, "pageSize": os.sysconf("SC_PAGE_SIZE"),
        "kernel": f"{platform.system()} {platform.release()}", "isolatedCores": [], "perfCounters": False,
        "toolchains": {"go": go, "python": f"cpython{platform.python_version()}"},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", default="http://127.0.0.1:8080/api")
    url = urlsplit(parser.parse_args().api)
    token = os.environ.pop("BENCHSCOPE_AGENT_TOKEN", "")
    if not token or url.scheme != "http" or url.hostname not in ("127.0.0.1", "::1", "localhost"):
        parser.error("Set BENCHSCOPE_AGENT_TOKEN and use a loopback HTTP API URL.")
    api = AgentAPI(url, token)
    machine = machine_snapshot()
    trusted = {lane["language"]: lane["files"]
               for lane in json.loads(FIXTURE.read_text())["workspaceSnapshot"]["lanes"]}
    worker = None
    job_id = None
    cancel = threading.Event()
    registration = None
    try:
        while True:
            if registration is None:
                registration = api.post("/agent/register", {"agentVersion": "0.1.0", "machine": machine,
                    "capabilities": {"os": platform.system().lower(), "languages": list(HARNESS),
                        "timerSource": TIMER["source"], "timerFreqHz": TIMER["freqHz"], "timerFreqCalibrated": False,
                        "perfCounters": {"l1dReadMisses": False, "branchMisses": False},
                        "pageFaultSplit": False, "canPinCore": False, "canLimitMemory": False}})
                print(f'Connected {machine["cpuModel"]} ({machine["arch"]}). Waiting for Array sum jobs.', flush=True)
            if worker is not None and not worker.is_alive():
                worker, job_id = None, None
            try:
                reply = api.post("/agent/poll", {"machineId": registration["machineId"],
                    "status": "busy" if worker else "idle", "jobId": job_id}, retry=False)
            except ApiError as exc:
                if exc.status == 404:
                    cancel.set()
                    if worker is not None:
                        worker.join()
                    registration = None
                    continue
                if exc.status < 500:
                    raise
                reply = {}
            except (OSError, http.client.HTTPException):
                reply = {}
            if reply.get("cancel"):
                cancel.set()
            job = reply.get("job")
            if job and worker is None:
                cancel = threading.Event()
                job_id = job["jobId"]
                worker = threading.Thread(target=run_job, args=(api, job, cancel, trusted, machine))
                worker.start()
            sleep(registration["pollIntervalMs"] / 1000)
    except KeyboardInterrupt:
        pass
    finally:
        cancel.set()
        if worker is not None:
            worker.join()


if __name__ == "__main__":
    if sys.argv[1:2] == ["--measure"]:
        measure_python(sys.argv[2], *map(int, sys.argv[3:]))
    else:
        main()
