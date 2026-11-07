"""Hardware performance counters (port of counter.go)."""

from __future__ import annotations

import abc
import sys
from enum import IntEnum


class HardwareCounter(abc.ABC):
    """Implemented by each individual counter to manage its lifecycle."""

    @abc.abstractmethod
    def Start(self) -> None: ...

    @abc.abstractmethod
    def Stop(self) -> None: ...

    @abc.abstractmethod
    def Read(self) -> int: ...

    @abc.abstractmethod
    def Close(self) -> None: ...

    def __enter__(self) -> "HardwareCounter":
        return self

    def __exit__(self, *exc: object) -> None:
        self.Close()


class Event(IntEnum):
    """A specific hardware counter."""

    EventBranchMisses = 0
    EventL1DataMisses = 1


EventBranchMisses = Event.EventBranchMisses
EventL1DataMisses = Event.EventL1DataMisses


def NewCounter(e: Event) -> HardwareCounter:
    """Open a hardware counter for event `e`. Raises OSError/NotImplementedError on failure."""
    if sys.platform.startswith("linux"):
        from ._counter_linux import newLinuxCounter

        return newLinuxCounter(e)
    raise NotImplementedError(f"hardware counters not implemented on {sys.platform}")
