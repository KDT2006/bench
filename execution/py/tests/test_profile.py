import gc
import io
import unittest
from contextlib import ExitStack, redirect_stdout
from datetime import timedelta
from unittest.mock import Mock, patch

from execution.py import profile, timer
from execution.py.counter import HardwareCounter
from execution.py.printer import PrintResult


class FakeCounter(HardwareCounter):
    def __init__(self, values):
        self.values = iter(values)
        self.Start = Mock()
        self.Stop = Mock()
        self.Close = Mock()

    def Start(self):
        pass

    def Stop(self):
        pass

    def Read(self):
        return next(self.values)

    def Close(self):
        pass


class ProfileTests(unittest.TestCase):
    def measure(self, durations, fenced=True, workload=None, cpu_freq=1000):
        count = len(durations)
        l1 = FakeCounter(range(10, 10 + count))
        branch = FakeCounter(range(20, 20 + count))
        work = workload if workload is not None else Mock()
        p = profile.NewRepProfile("example", 1024**3, work, timedelta(seconds=1), cpu_freq)
        faults = [sample for i in range(count) for sample in ((0, 0), (i, i + 1))]
        with ExitStack() as stack:
            stack.enter_context(patch.object(profile, "_PinnedThread"))
            factory = stack.enter_context(patch.object(profile, "NewCounter", side_effect=[l1, branch]))
            stack.enter_context(patch.object(profile.time, "monotonic", side_effect=[0] + [0.5] * count + [1]))
            stack.enter_context(patch.object(profile, "GetPageFaultCount", side_effect=faults))
            start = stack.enter_context(patch.object(timer, "ReadCPUTimerStartFenced", return_value=100))
            end = stack.enter_context(patch.object(timer, "ReadCPUTimerEndFenced", side_effect=[100 + d for d in durations]))
            plain = stack.enter_context(patch.object(timer, "ReadCPUTimer", side_effect=[t for d in durations for t in (100, 100 + d)]))
            output = stack.enter_context(redirect_stdout(io.StringIO()))
            was_enabled = gc.isenabled()
            try:
                result = p.Start(fenced)
            finally:
                l1.Close.assert_called_once()
                branch.Close.assert_called_once()
                self.assertEqual(gc.isenabled(), was_enabled)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(work.call_count, count)
        self.assertEqual([c.args[0] for c in factory.call_args_list], [profile.EventL1DataMisses, profile.EventBranchMisses])
        for counter in (l1, branch):
            self.assertEqual(counter.Start.call_count, count)
            self.assertEqual(counter.Stop.call_count, count)
        self.assertEqual(start.call_count, count if fenced else 0)
        self.assertEqual(end.call_count, count if fenced else 0)
        self.assertEqual(plain.call_count, 0 if fenced else 2 * count)
        return p, result

    def test_extrema_and_totals_in_both_timer_modes(self):
        for fenced in (True, False):
            with self.subTest(fenced=fenced):
                _, r = self.measure([50, 20, 90, 40], fenced)
                self.assertEqual((r.Iterations(), r.MinTime, r.MaxTime, r.TotalTime, r.AvgTime), (4, 20, 90, 200, 50))
                self.assertEqual((r.TotalPageFaults(), r.PageFaultCountAvg), (16, 4))
                self.assertEqual((r.MajorPageFaultCountMin, r.MinorPageFaultCountMin), (1, 2))
                self.assertEqual((r.MajorPageFaultCountMax, r.MinorPageFaultCountMax), (2, 3))
                self.assertEqual((r.L1DataMissMin, r.L1DataMissMax), (11, 12))
                self.assertEqual((r.BranchMisssMin, r.BranchMissMax), (21, 22))
                self.assertAlmostEqual(r.GigabytesPerSecondMin, 50)
                self.assertAlmostEqual(r.GigabytesPerSecondMax, 1000 / 90)
                self.assertAlmostEqual(r.GigabytesPerSecondAvg, 20)

    def test_single_iteration_records_all_counters(self):
        _, r = self.measure([50])
        self.assertEqual((r.MinTime, r.MaxTime, r.AvgTime), (50, 50, 50))
        self.assertEqual((r.L1DataMissMin, r.L1DataMissMax), (10, 10))
        self.assertEqual((r.BranchMisssMin, r.BranchMissMax), (20, 20))

    def test_empty_run(self):
        p, r = self.measure([])
        self.assertEqual(r, profile.RepetitionProfileResults())
        output = io.StringIO()
        PrintResult(output, p, r)
        self.assertTrue(output.getvalue().endswith("Iterations: 0\nNo measurements collected.\n"))
        self.assertNotIn("Ticks:", output.getvalue())

    def test_workload_failure_closes_counters_and_restores_gc(self):
        with self.assertRaisesRegex(RuntimeError, "work failed"):
            self.measure([10], workload=Mock(side_effect=RuntimeError("work failed")))

    def test_partial_counter_setup_failure_closes_first_counter(self):
        counter = FakeCounter([])
        was_enabled = gc.isenabled()
        with patch.object(profile, "_PinnedThread"), patch.object(
            profile, "NewCounter", side_effect=[counter, OSError("counter unavailable")]
        ):
            with self.assertRaisesRegex(OSError, "counter unavailable"):
                profile.NewRepProfile("error", 0, lambda: None, 1, 1000).Start(True)
        counter.Close.assert_called_once()
        self.assertEqual(gc.isenabled(), was_enabled)

    def test_printer_metrics_and_units(self):
        p, r = self.measure([50, 20, 90, 40])
        output = io.StringIO()
        PrintResult(output, p, r)
        self.assertEqual(output.getvalue(), (
            "--- example ---\n"
            "Timer frequency: 1000 ticks/s\n"
            "Bytes/iteration: 1073741824 | Run window: 1s\n"
            "Iterations: 4\n"
            "Ticks: min=20  max=90  avg=50.00  total=200\n"
            "Time: min=20000.000 us  max=90000.000 us  avg=50000.000 us  total=200.000 ms\n"
            "Throughput (GiB/s): fastest=50.000  slowest=11.111  average=20.000\n"
            "Page faults: total=16  average/iteration=4.000000\n"
            "  Fastest iteration: major=1  minor=2\n"
            "  Slowest iteration: major=2  minor=3\n"
            "L1 data misses: fastest=11  slowest=12\n"
            "Branch misses: fastest=21  slowest=22\n"
        ))

    def test_zero_frequency_and_zero_ticks(self):
        p, r = self.measure([0], cpu_freq=0)
        self.assertEqual(r.GigabytesPerSecondAvg, 0)
        output = io.StringIO()
        PrintResult(output, p, r)
        self.assertIn("Time / throughput: unavailable (timer frequency is zero)", output.getvalue())

    def test_known_frequency_skips_calibration(self):
        with patch.object(timer, "ReadCPUTimerFrequency", return_value=24_000_000), patch.object(profile, "ReadOSTimer") as os_timer:
            self.assertEqual(profile.GetCPUFreqWait(20), 24_000_000)
        os_timer.assert_not_called()

    def test_frequency_calibration(self):
        with (
            patch.object(timer, "ReadCPUTimerFrequency", return_value=0),
            patch.object(timer, "ReadCPUTimerStartFenced", return_value=100),
            patch.object(timer, "ReadCPUTimerEndFenced", return_value=40_000_100),
            patch.object(profile, "ReadOSTimer", side_effect=[0, 10_000_000, 20_000_000]),
        ):
            self.assertEqual(profile.GetCPUFreqWait(20), 2_000_000_000)

    def test_known_backend_frequencies(self):
        with patch.object(timer, "TIMER_BACKEND", "perf_counter_ns"):
            self.assertEqual(timer._select_frequency_reader()(), 1_000_000_000)
        with patch.object(timer, "TIMER_BACKEND", "native-arm64"), patch.object(
            timer._native, "load_stub", return_value=lambda: 24_000_000
        ):
            self.assertEqual(timer._select_frequency_reader()(), 24_000_000)
        with patch.object(timer, "TIMER_BACKEND", "native-x86_64"):
            self.assertEqual(timer._select_frequency_reader()(), 0)


if __name__ == "__main__":
    unittest.main()
