"""Validate interpreter arguments while preserving the generated benchmark entrypoint."""


def validate_compiler_flags(flags):
    if not isinstance(flags, list) or len(flags) > 64:
        raise ValueError("compilerFlags must be a list of at most 64 arguments")
    if any(not isinstance(arg, str) or not arg or len(arg.encode("utf-8")) > 4096 or "\0" in arg for arg in flags):
        raise ValueError("compilerFlags must contain nonempty strings of at most 4096 bytes without NUL characters")
    index = 0
    while index < len(flags):
        arg = flags[index]
        if arg in {"-O", "-OO", "-B", "-b", "-bb", "-u", "-E", "-I", "-P", "-s", "-S", "-d", "-v", "-vv", "-q"}:
            pass
        elif arg in {"-W", "-X", "--check-hash-based-pycs"}:
            index += 1
            if index >= len(flags) or not flags[index] or flags[index].startswith("-"):
                raise ValueError(f"interpreter option {arg} requires a value")
        elif arg.startswith(("-W", "-X")) and len(arg) > 2:
            pass
        else:
            raise ValueError(f"unsupported Python interpreter option {arg!r}; use -O, -OO, -B, -b, -bb, -u, -E, -I, -P, -s, -S, -d, -v, -vv, -q, -W, -X or --check-hash-based-pycs")
        index += 1
    return list(flags)
