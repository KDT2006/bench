import platform
from pathlib import Path
import sys
import shutil
import unittest

from execution.py.assembly import bind_native, is_nasm, nasm_target, validate_source, SOURCE_CHAR_LIMIT
from execution.py.execution import ExecutionConfig, ExecutionError, ParseExecutionConfig, RunExecution, RunSweep


class AssemblyTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform in ("linux", "darwin") and platform.machine().lower() in
                         ("x86_64", "amd64", "arm64", "aarch64"), "native host required")
    def test_native_abi_and_sweep(self):
        self._native_abi_and_sweep("native.S")

    @unittest.skipUnless(platform.machine().lower() in ("x86_64", "amd64") and shutil.which("nasm"), "NASM and x64 required")
    def test_nasm_abi_and_sweep(self):
        self._native_abi_and_sweep("native.asm")

    def _native_abi_and_sweep(self, fixture):
        assembly = (Path(__file__).parents[2] / "testdata" / fixture).read_text()
        cfg = ParseExecutionConfig({"name": "native ABI", "assembly": assembly, "code": """#imports
import ctypes
#globals
def Add64(a: ctypes.c_uint64, b: ctypes.c_uint64) -> ctypes.c_uint64: ...
def Store64(p: ctypes.POINTER(ctypes.c_uint64), value: ctypes.c_uint64) -> None: ...
def Twice(value: ctypes.c_double) -> ctypes.c_double: pass
def Answer() -> ctypes.c_uint64: ...
def MultiNOP(count: ctypes.c_uint64) -> None: ...
def helper(): return 7
#sweep
N: [0, 9]
#setup
value = ctypes.c_uint64()
#bench
Store64(ctypes.byref(value), Add64(1 << 40, helper()))
MultiNOP(N)
#cleanup
assert value.value == (1 << 40) + 7
assert Twice(1.25) == 2.5
assert Answer() == 42
"""})
        cfg.BenchDuration = 0.001
        if fixture == "native.asm":
            cfg.Globals += "\ndef MOVAllBytesASM(count: ctypes.c_uint64, data: ctypes.POINTER(ctypes.c_uint8)) -> None: ...\ndef CMPAllBytesASM(count: ctypes.c_uint64) -> None: ...\ndef DECAllBytesASM(count: ctypes.c_uint64) -> None: ...\n"
            cfg.Setup += "buffer = (ctypes.c_uint8 * 10)(*[255] * 10)\n"
            cfg.Bench += "MOVAllBytesASM(N, buffer)\nCMPAllBytesASM(N)\nDECAllBytesASM(N)\n"
            cfg.Cleanup += "assert list(buffer) == list(range(N)) + [255] * (10 - N)\n"
        results = RunSweep(cfg)
        self.assertEqual(len(results), 2)
        self.assertTrue(all(result["iterations"] > 0 for result in results))

    def test_nasm_detection_and_targets(self):
        for source in ("; comment\nglobal F\nsection .text", "[BITS 64]", "%define COUNT 9", "GLOBAL F"):
            self.assertTrue(is_nasm(source), source)
        for source in (".text\n.globl F\nF:\nret", "// global F\n.text", "#ifdef __APPLE__\n.globl _F\n#endif"):
            self.assertFalse(is_nasm(source), source)
        self.assertEqual(nasm_target("linux", "x86_64"), ["-f", "elf64"])
        self.assertEqual(nasm_target("darwin", "amd64"), ["-f", "macho64", "--prefix", "_"])
        with self.assertRaisesRegex(ValueError, "x64 executor"):
            nasm_target("darwin", "arm64")

    def test_rejected_declarations(self):
        for source in ("", "def f(x): ...", "def f() -> str: ...", "def f(*x: int) -> None: ...",
                       "def f(x: int = 0) -> None: ...", "async def f() -> None: ...",
                       "@decorator\ndef f() -> None: ...", "def f(*, x: int) -> None: ..."):
            with self.subTest(source=source), self.assertRaises(ValueError):
                bind_native(source, "native.so")

    def test_size_and_type_validation(self):
        for field in ("code", "assembly"):
            for value in (None, 12, "x" * (SOURCE_CHAR_LIMIT + 1), "\0"):
                with self.subTest(field=field, value=str(value)[:20]), self.assertRaises(ValueError):
                    ParseExecutionConfig({"name": "limit", "code": "#bench\npass", field: value})
        validate_source("🦊" * SOURCE_CHAR_LIMIT, "assembly")

    def test_compiler_and_missing_symbol_diagnostics(self):
        for assembly, diagnostic in (("not_an_instruction", "compile native assembly"),
                                      (".text\n", "MissingSymbol")):
            with self.subTest(assembly=assembly), self.assertRaisesRegex(ExecutionError, diagnostic):
                RunExecution(ExecutionConfig(Assembly=assembly, Globals="def MissingSymbol() -> None: ...",
                                             Bench="MissingSymbol()", BenchDuration=0.001))


if __name__ == "__main__":
    unittest.main()
