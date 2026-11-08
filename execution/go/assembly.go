package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"unicode/utf8"
)

const sourceCharLimit = 65536

func validateSourceSize(source, field string) error {
	if utf8.RuneCountInString(source) > sourceCharLimit {
		return fmt.Errorf("%s must be at most %d characters", field, sourceCharLimit)
	}
	if strings.ContainsRune(source, 0) {
		return fmt.Errorf("%s must not contain NUL characters", field)
	}
	return nil
}

func nativePlatform() error {
	if (runtime.GOOS != "linux" && runtime.GOOS != "darwin") || (runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64") {
		return fmt.Errorf("native assembly requires Linux or macOS on x64 or ARM64")
	}
	return nil
}

// NASM sources declare their format with directives such as global/section.
// Retain the existing GNU/Clang path for .S sources and ARM64.
var nasmDirective = regexp.MustCompile(`(?im)^\s*(?:\[\s*)?(?:(?:global|extern|section|segment|bits|default|common|absolute)\b|%[a-z])`)

func isNASM(source string) bool { return nasmDirective.MatchString(source) }

func nasmTarget(goos, arch string) ([]string, error) {
	if arch != "amd64" {
		return nil, fmt.Errorf("NASM syntax requires an x64 executor; ARM64 uses GNU/Clang assembly")
	}
	if goos == "darwin" {
		return []string{"-f", "macho64", "--prefix", "_"}, nil
	}
	if goos == "linux" {
		return []string{"-f", "elf64"}, nil
	}
	return nil, fmt.Errorf("NASM requires Linux or macOS")
}

// Compile native C ABI assembly into an object for cgo to link.
func compileNative(ctx context.Context, dir, source string) (string, error) {
	if err := nativePlatform(); err != nil {
		return "", err
	}
	output, err := exec.CommandContext(ctx, "go", "env", "-json", "CC", "CGO_ENABLED", "GOOS", "GOARCH").Output()
	if err != nil {
		return "", fmt.Errorf("read cgo configuration: %w", err)
	}
	var env map[string]string
	if err := json.Unmarshal(output, &env); err != nil {
		return "", err
	}
	if env["CGO_ENABLED"] != "1" {
		return "", fmt.Errorf("native assembly requires CGO_ENABLED=1 and a C compiler")
	}
	if env["GOOS"] != runtime.GOOS || env["GOARCH"] != runtime.GOARCH {
		return "", fmt.Errorf("native assembly cannot cross-compile; use the matching executor")
	}
	if isNASM(source) {
		args, err := nasmTarget(runtime.GOOS, runtime.GOARCH)
		if err != nil {
			return "", err
		}
		path, object := filepath.Join(dir, "native.asm"), filepath.Join(dir, "native.o")
		if runtime.GOOS == "linux" {
			source += "\nsection .note.GNU-stack noalloc noexec nowrite progbits\n"
		}
		if err := os.WriteFile(path, []byte(source), 0600); err != nil {
			return "", err
		}
		if _, err := exec.LookPath("nasm"); err != nil {
			return "", fmt.Errorf("native assembly requires nasm installed on the x64 executor")
		}
		args = append(args, "-o", object, path)
		if output, err := exec.CommandContext(ctx, "nasm", args...).CombinedOutput(); err != nil {
			return "", fmt.Errorf("compile native assembly (NASM): %w\n%s", err, output)
		}
		return object, nil
	}
	compiler := strings.Fields(env["CC"])
	if len(compiler) == 0 {
		return "", fmt.Errorf("native assembly requires a C compiler")
	}
	path, object := filepath.Join(dir, "native.S"), filepath.Join(dir, "native.o")
	if runtime.GOOS == "linux" {
		source += "\n.section .note.GNU-stack,\"\"\n"
	}
	if err := os.WriteFile(path, []byte(source), 0600); err != nil {
		return "", err
	}
	args := append(compiler[1:], "-c", "-fPIC", "-x", "assembler-with-cpp", path, "-o", object)
	if output, err := exec.CommandContext(ctx, compiler[0], args...).CombinedOutput(); err != nil {
		return "", fmt.Errorf("compile native assembly: %w\n%s", err, output)
	}
	return object, nil
}

type nativeBindings struct {
	globals, prototypes string
	unsafe              bool
}

// Bodyless declarations need a native implementation in this product. Without
// this check, an empty/dropped assembly field leaks through as Go's misleading
// "missing function body" error during the generated program's build.
func validateNativeImplementation(globals, assembly string) error {
	if strings.TrimSpace(assembly) != "" {
		return nil
	}
	file, err := parser.ParseFile(token.NewFileSet(), "globals.go", "package main\n"+globals, parser.ParseComments)
	if err != nil {
		return nil
	} // Let source generation report syntax errors.
	linked := linkedGoFunctions(file)
	for _, decl := range file.Decls {
		if fn, ok := decl.(*ast.FuncDecl); ok && fn.Body == nil && !linked[fn.Name.Name] {
			return fmt.Errorf("assembly source is required for bodyless function %s; add its implementation in this lane's assembly editor", fn.Name.Name)
		}
	}
	return nil
}

func linkedGoFunctions(file *ast.File) map[string]bool {
	linked := make(map[string]bool)
	for _, group := range file.Comments {
		for _, comment := range group.List {
			fields := strings.Fields(comment.Text)
			if len(fields) >= 2 && fields[0] == "//go:linkname" {
				linked[fields[1]] = true
			}
		}
	}
	return linked
}

var nativeTypes = map[string]string{
	"int8": "int8_t", "uint8": "uint8_t", "byte": "uint8_t",
	"int16": "int16_t", "uint16": "uint16_t", "int32": "int32_t", "rune": "int32_t", "uint32": "uint32_t",
	"int64": "int64_t", "uint64": "uint64_t", "int": "intptr_t", "uint": "uintptr_t", "uintptr": "uintptr_t",
	"float32": "float", "float64": "double",
}

func nativeType(expr ast.Expr) (goType, cType, cast string, pointer bool, err error) {
	if id, ok := expr.(*ast.Ident); ok {
		if ct, ok := nativeTypes[id.Name]; ok {
			return id.Name, ct, "C." + ct, false, nil
		}
	}
	if ptr, ok := expr.(*ast.StarExpr); ok {
		if id, ok := ptr.X.(*ast.Ident); ok {
			if ct, ok := nativeTypes[id.Name]; ok {
				return "*" + id.Name, ct + "*", "(*C." + ct + ")", true, nil
			}
		}
	}
	return "", "", "", false, fmt.Errorf("native assembly signatures support numeric scalars and pointers to numeric scalars")
}

// Replace bodyless functions in #globals with typed cgo calls. Functions with
// bodies stay Go functions. Each stub names an exported native C ABI symbol.
func bindNative(globals string) (nativeBindings, error) {
	const prefix = "package main\n"
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "globals.go", prefix+globals, parser.ParseComments)
	if err != nil {
		return nativeBindings{}, fmt.Errorf("native assembly declarations: %w", err)
	}
	result := nativeBindings{globals: globals}
	linked := linkedGoFunctions(file)
	type edit struct {
		start, end int
		body       string
	}
	var edits []edit
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Body != nil || linked[fn.Name.Name] {
			continue
		}
		if fn.Recv != nil || fn.Type.TypeParams != nil || fn.Name.Name == "_" || fn.Name.Name == "init" || fn.Name.Name == "main" {
			return result, fmt.Errorf("invalid native assembly function %s", fn.Name.Name)
		}
		var parameters, arguments []string
		if fn.Type.Params != nil {
			for _, field := range fn.Type.Params.List {
				_, ct, cast, ptr, err := nativeType(field.Type)
				if err != nil {
					return result, fmt.Errorf("%s: %w", fn.Name.Name, err)
				}
				if len(field.Names) == 0 {
					return result, fmt.Errorf("%s: native parameters must be named", fn.Name.Name)
				}
				for _, name := range field.Names {
					if name.Name == "_" {
						return result, fmt.Errorf("%s: native parameters must be named", fn.Name.Name)
					}
					// Wrapper-local names cannot shadow C, unsafe, or a scalar type.
					name.Name = fmt.Sprintf("__bench_native_arg%d", len(arguments))
					argument := name.Name
					if ptr {
						argument = "__bench_asm_unsafe.Pointer(" + argument + ")"
						result.unsafe = true
					}
					arguments = append(arguments, cast+"("+argument+")")
					parameters = append(parameters, ct)
				}
			}
		}
		ret, goRet, retPtr := "void", "", false
		if fn.Type.Results != nil && len(fn.Type.Results.List) != 0 {
			if len(fn.Type.Results.List) != 1 || len(fn.Type.Results.List[0].Names) > 1 {
				return result, fmt.Errorf("%s: native functions support at most one return value", fn.Name.Name)
			}
			goRet, ret, _, retPtr, err = nativeType(fn.Type.Results.List[0].Type)
			if err != nil {
				return result, fmt.Errorf("%s: %w", fn.Name.Name, err)
			}
			fn.Type.Results.List[0].Names = nil
		}
		if len(parameters) == 0 {
			parameters = []string{"void"}
		}
		result.prototypes += fmt.Sprintf("extern %s %s(%s);\n", ret, fn.Name.Name, strings.Join(parameters, ", "))
		call := "C." + fn.Name.Name + "(" + strings.Join(arguments, ", ") + ")"
		if goRet != "" {
			if retPtr {
				call = "__bench_asm_unsafe.Pointer(" + call + ")"
				result.unsafe = true
			}
			call = "return (" + goRet + ")(" + call + ")"
		}
		var signature bytes.Buffer
		fn.Doc = nil // Comments already remain before fn.Pos() in the original source.
		if err := format.Node(&signature, fset, fn); err != nil {
			return result, err
		}
		edits = append(edits, edit{fset.Position(fn.Pos()).Offset - len(prefix), fset.Position(fn.End()).Offset - len(prefix), signature.String() + " { " + call + " }"})
	}
	if len(edits) == 0 {
		return result, fmt.Errorf("assembly requires at least one bodyless function declaration in #globals")
	}
	for i := len(edits) - 1; i >= 0; i-- {
		e := edits[i]
		result.globals = result.globals[:e.start] + e.body + result.globals[e.end:]
	}
	return result, nil
}
