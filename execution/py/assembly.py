"""Compile native C ABI assembly and replace typed Python skeleton functions."""

import ast
import os
from pathlib import Path
import platform
import re
import shlex
import subprocess
import sys
from time import monotonic

SOURCE_CHAR_LIMIT = 65536
_NASM_DIRECTIVE = re.compile(r"^\s*(?:\[\s*)?(?:(?:global|extern|section|segment|bits|default|common|absolute)\b|%[a-z])", re.I | re.M)


def is_nasm(source):
    return bool(_NASM_DIRECTIVE.search(source))


def nasm_target(os_name, arch):
    if arch.lower() not in ("amd64", "x86_64"):
        raise ValueError("NASM syntax requires an x64 executor; ARM64 uses GNU/Clang assembly")
    if os_name == "darwin":
        return ["-f", "macho64", "--prefix", "_"]
    if os_name == "linux":
        return ["-f", "elf64"]
    raise ValueError("NASM requires Linux or macOS")


def validate_source(source, field):
    if not isinstance(source, str):
        raise ValueError(f"{field} must be a string")
    if len(source) > SOURCE_CHAR_LIMIT:
        raise ValueError(f"{field} must be at most {SOURCE_CHAR_LIMIT} characters")
    if "\0" in source:
        raise ValueError(f"{field} must not contain NUL characters")


def native_platform():
    if sys.platform not in ("linux", "darwin") or platform.machine().lower() not in (
            "amd64", "x86_64", "arm64", "aarch64"):
        raise ValueError("native assembly requires Linux or macOS on x64 or ARM64")


def compile_native(directory, source, timeout):
    native_platform()
    validate_source(source, "assembly")
    deadline = monotonic() + timeout
    library = Path(directory) / ("native.dylib" if sys.platform == "darwin" else "native.so")
    compiler = shlex.split(os.environ.get("CC", "cc"))
    if not compiler:
        raise ValueError("native assembly requires a C compiler (CC or cc)")
    if is_nasm(source):
        args = nasm_target(sys.platform, platform.machine())
        source_path, object_path = Path(directory) / "native.asm", Path(directory) / "native.o"
        if sys.platform == "linux":
            source += '\nsection .note.GNU-stack noalloc noexec nowrite progbits\n'
        source_path.write_text(source, encoding="utf-8")
        _compile(["nasm", *args, "-o", str(object_path), str(source_path)], timeout, "NASM (install nasm on the executor)")
        command = compiler + ["-dynamiclib" if sys.platform == "darwin" else "-shared", str(object_path), "-o", str(library)]
    else:
        source_path = Path(directory) / "native.S"
        if sys.platform == "linux":
            source += '\n.section .note.GNU-stack,""\n'
        source_path.write_text(source, encoding="utf-8")
        command = compiler + ["-dynamiclib" if sys.platform == "darwin" else "-shared", "-fPIC",
                              "-x", "assembler-with-cpp", str(source_path), "-o", str(library)]
    _compile(command, max(0.001, deadline - monotonic()), "C compiler")
    return library


def _compile(command, timeout, tool):
    try:
        result = subprocess.run(command, capture_output=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired as exc:
        raise TimeoutError("native assembly compilation timed out") from exc
    except OSError as exc:
        raise ValueError(f"compile native assembly: {tool} unavailable: {exc}") from exc
    if result.returncode:
        raise ValueError("compile native assembly:\n" + result.stderr[-65536:].decode(errors="replace"))


_TYPES = {name: name for name in (
    "c_int8", "c_uint8", "c_int16", "c_uint16", "c_int32", "c_uint32", "c_int64", "c_uint64",
    "c_byte", "c_ubyte", "c_short", "c_ushort", "c_int", "c_uint", "c_long", "c_ulong",
    "c_longlong", "c_ulonglong", "c_size_t", "c_ssize_t", "c_float", "c_double", "c_void_p")}
_TYPES.update({"int": "c_ssize_t", "float": "c_double"})


def _type(annotation, *, result=False):
    if isinstance(annotation, ast.Constant) and isinstance(annotation.value, str):
        annotation = ast.parse(annotation.value, mode="eval").body
    if result and isinstance(annotation, ast.Constant) and annotation.value is None:
        return "None"
    name = annotation.id if isinstance(annotation, ast.Name) else (
        annotation.attr if isinstance(annotation, ast.Attribute) and isinstance(annotation.value, ast.Name)
        and annotation.value.id == "ctypes" else None)
    if name in _TYPES:
        return "__bench_ctypes." + _TYPES[name]
    if isinstance(annotation, ast.Call) and not annotation.keywords and len(annotation.args) == 1:
        target = ast.unparse(annotation.func)
        if target in ("POINTER", "ctypes.POINTER"):
            return "__bench_ctypes.POINTER(" + _type(annotation.args[0]) + ")"
    raise ValueError("native assembly stubs need ctypes numeric/pointer annotations and an explicit return type (None for void)")


def bind_native(globals_source, library):
    """Only module-level pass/ellipsis stubs are bound; helpers retain their bodies."""
    program = ast.parse(globals_source, filename="<assembly declarations>")
    declarations = []
    count = 0
    for node in program.body:
        body = getattr(node, "body", [])
        if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
            body = body[1:]
        stub = len(body) == 1 and (isinstance(body[0], ast.Pass) or (
            isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant)
            and body[0].value.value is Ellipsis))
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) or not stub:
            declarations.append(node)
            continue
        args = node.args
        if isinstance(node, ast.AsyncFunctionDef) or node.decorator_list or args.vararg or args.kwarg or args.kwonlyargs or args.defaults:
            raise ValueError(f"{node.name}: native stubs require plain positional parameters without decorators or defaults")
        argtypes = [_type(arg.annotation) for arg in args.posonlyargs + args.args]
        restype = _type(node.returns, result=True)
        declarations.extend(ast.parse(
            f"{node.name} = __bench_native_library.{node.name}\n"
            f"{node.name}.argtypes = [{', '.join(argtypes)}]\n"
            f"{node.name}.restype = {restype}\n"
        ).body)
        count += 1
    if not count:
        raise ValueError("assembly requires at least one typed pass or ellipsis function stub in #globals")
    preamble = ast.parse("import ctypes as __bench_ctypes\n" +
                         f"__bench_native_library = __bench_ctypes.CDLL({str(library)!r})\n").body
    program.body = preamble + declarations
    return ast.unparse(ast.fix_missing_locations(program))
