"""Run real workloads and print metrics, like the Go tests' runProfile helper."""

import sys
import unittest
from datetime import timedelta
from typing import Callable

from execution.py.printer import PrintResult
from execution.py.profile import GetCPUFreqWait, NewRepProfile


def run_profile(
    test: unittest.TestCase,
    byte_count: int,
    work: Callable[[], None],
    check_output: Callable[[], None],
) -> None:
    cpu_freq = GetCPUFreqWait(20)
    test.assertGreater(cpu_freq, 0, "CPU timer frequency is zero")

    for mode in ("Fenced", "Unfenced"):
        with test.subTest(mode=mode):
            calls = 0

            def measured_work() -> None:
                nonlocal calls
                work()
                calls += 1

            profile = NewRepProfile(
                f"{test.id()}/{mode}",
                byte_count,
                lambda measure: measure(measured_work),
                timedelta(milliseconds=100),
                cpu_freq,
            )
            result = profile.Start(mode == "Fenced")
            test.assertGreater(calls, 0, "No workload calls completed")
            test.assertEqual(result.Iterations(), calls)
            test.assertGreater(result.TotalTime, 0)
            test.assertLessEqual(result.MinTime, result.AvgTime)
            test.assertLessEqual(result.AvgTime, result.MaxTime)
            check_output()

            sys.stdout.write("\n")
            PrintResult(sys.stdout, profile, result)
            sys.stdout.flush()
