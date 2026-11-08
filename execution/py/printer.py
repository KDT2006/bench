"""Human-readable repetition profile metrics (port of print.go)."""

from __future__ import annotations

from typing import TextIO

from .profile import RepetitionProfile, RepetitionProfileResults, _to_seconds


def PrintResult(
    out: TextIO, profile: RepetitionProfile, result: RepetitionProfileResults
) -> None:
    """Write metrics to a text stream, such as sys.stdout or io.StringIO."""
    out.write(f"--- {profile.Name} ---\n")
    out.write(f"Timer frequency: {profile.CPUFreq} ticks/s\n")
    out.write(
        f"Bytes/iteration: {profile.ByteCount} | "
        f"Run window: {_to_seconds(profile.TryForTime):g}s\n"
    )
    out.write(f"Iterations: {result.Iterations()}\n")
    if result.Iterations() == 0:
        out.write("No measurements collected.\n")
        return

    out.write(
        f"Ticks: min={result.MinTime}  max={result.MaxTime}  "
        f"avg={result.AvgTime:.2f}  total={result.TotalTime}\n"
    )
    if profile.CPUFreq > 0:
        microsecondsPerTick = 1e6 / profile.CPUFreq
        out.write(
            f"Time: min={result.MinTime * microsecondsPerTick:.3f} us  "
            f"max={result.MaxTime * microsecondsPerTick:.3f} us  "
            f"avg={result.AvgTime * microsecondsPerTick:.3f} us  "
            f"total={result.TotalTime * microsecondsPerTick / 1000:.3f} ms\n"
        )
        out.write(
            f"Throughput (GiB/s): fastest={result.GigabytesPerSecondMin:.3f}  "
            f"slowest={result.GigabytesPerSecondMax:.3f}  "
            f"average={result.GigabytesPerSecondAvg:.3f}\n"
        )
    else:
        out.write("Time / throughput: unavailable (timer frequency is zero)\n")

    out.write(
        f"Page faults: total={result.TotalPageFaults()}  "
        f"average/iteration={result.PageFaultCountAvg:.6f}\n"
    )
    out.write(
        f"  Fastest iteration: major={result.MajorPageFaultCountMin}  "
        f"minor={result.MinorPageFaultCountMin}\n"
    )
    out.write(
        f"  Slowest iteration: major={result.MajorPageFaultCountMax}  "
        f"minor={result.MinorPageFaultCountMax}\n"
    )
    if not result.HardwareCountersError:
        out.write(
            f"L1 data misses: fastest={result.L1DataMissMin}  "
            f"slowest={result.L1DataMissMax}\n"
        )
        out.write(
            f"Branch misses: fastest={result.BranchMisssMin}  "
            f"slowest={result.BranchMissMax}\n"
        )
    else:
        reason = result.HardwareCountersError
        out.write(
            f"L1 data misses: unavailable ({reason})\n"
            f"Branch misses: unavailable ({reason})\n"
        )


__all__ = ["PrintResult"]
