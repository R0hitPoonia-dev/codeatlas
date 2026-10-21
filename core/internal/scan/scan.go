// Package scan runs the language analyzers over a checkout and validates their IR.
// The CLI uploads the results; the API server stores them directly.
package scan

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"codeatlas/core/ir"
)

type Options struct {
	Root   string // checkout to analyse
	Repo   string // repo name recorded in the IR
	Commit string
	Branch string // optional
	OutDir string // where analyzers write IR files
	Log    io.Writer
}

// Run runs every analyzer that applies to o.Root and calls emit with each validated
// document. A failing analyzer is logged and the others still run; Run then returns an
// error naming the failures. An error from emit stops the scan.
func Run(ctx context.Context, o Options, emit func(lang string, doc *ir.Document, path string) error) error {
	langs := Detect(o.Root)
	fmt.Fprintf(o.Log, "%s @ %s — detected: %s\n", o.Repo, Short(o.Commit), strings.Join(langs, ", "))
	var failed []string
	for _, lang := range langs {
		if err := ctx.Err(); err != nil {
			return err
		}
		argv, err := Analyzer(lang)
		if err != nil {
			fmt.Fprintf(o.Log, "skipping %s: %v\n", lang, err)
			failed = append(failed, lang)
			continue
		}
		out := filepath.Join(o.OutDir, lang+".ir.json")
		argv = append(argv, o.Root, "--repo", o.Repo, "--commit", o.Commit, "--out", out)
		if o.Branch != "" {
			argv = append(argv, "--branch", o.Branch)
		}
		c := exec.CommandContext(ctx, argv[0], argv[1:]...)
		c.Stdout, c.Stderr = o.Log, o.Log
		c.WaitDelay = 5 * time.Second
		start := time.Now()
		if err := c.Run(); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			fmt.Fprintf(o.Log, "%s analyzer failed: %v\n", lang, err)
			failed = append(failed, lang)
			continue
		}
		doc, err := ReadDoc(out, o.Log)
		if err != nil {
			fmt.Fprintf(o.Log, "%s: %v\n", lang, err)
			failed = append(failed, lang)
			continue
		}
		fmt.Fprintf(o.Log, "%s: %d nodes, %d edges in %s\n", lang, len(doc.Nodes), len(doc.Edges),
			time.Since(start).Round(time.Millisecond))
		if err := emit(lang, doc, out); err != nil {
			return err
		}
	}
	if len(failed) > 0 {
		return fmt.Errorf("analyzers failed: %s", strings.Join(failed, ", "))
	}
	return nil
}

// Detect returns which analyzers apply to the repo. Infra always runs.
func Detect(root string) []string {
	var java, ts bool
	filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			n := d.Name()
			if p != root && (strings.HasPrefix(n, ".") || n == "node_modules" || n == "target" || n == "build" || n == "dist" || n == "vendor") {
				return filepath.SkipDir
			}
			return nil
		}
		switch ext := filepath.Ext(d.Name()); ext {
		case ".java":
			java = true
		case ".ts", ".tsx", ".js", ".jsx", ".mjs":
			if !strings.HasSuffix(d.Name(), ".d.ts") {
				ts = true
			}
		}
		if java && ts {
			return filepath.SkipAll
		}
		return nil
	})
	var langs []string
	if java {
		langs = append(langs, "java")
	}
	if ts {
		langs = append(langs, "typescript")
	}
	return append(langs, "infra")
}

// Analyzer returns the command line (without the repo dir and flags) for lang's analyzer,
// looked up from CODEATLAS_*_ANALYZER, then next to the running binary, then in the
// source tree layout that `make build` produces.
func Analyzer(lang string) ([]string, error) {
	exe, _ := os.Executable()
	exeDir := filepath.Dir(exe)
	find := func(env string, candidates ...string) (string, error) {
		if v := os.Getenv(env); v != "" {
			return v, nil
		}
		for _, c := range candidates {
			if _, err := os.Stat(c); err == nil {
				return c, nil
			}
		}
		return "", fmt.Errorf("not found; set %s", env)
	}
	switch lang {
	case "java":
		jar, err := find("CODEATLAS_JAVA_ANALYZER",
			filepath.Join(exeDir, "codeatlas-java.jar"),
			filepath.Join(exeDir, "../analyzers/java/target/codeatlas-java.jar"))
		return []string{"java", "-jar", jar}, err
	case "typescript":
		js, err := find("CODEATLAS_TS_ANALYZER",
			filepath.Join(exeDir, "codeatlas-ts/dist/src/main.js"),
			filepath.Join(exeDir, "../analyzers/typescript/dist/src/main.js"))
		return []string{"node", js}, err
	case "infra":
		if p, err := exec.LookPath("codeatlas-infra"); err == nil && os.Getenv("CODEATLAS_INFRA_ANALYZER") == "" {
			return []string{p}, nil
		}
		bin, err := find("CODEATLAS_INFRA_ANALYZER", filepath.Join(exeDir, "codeatlas-infra"))
		return []string{bin}, err
	}
	return nil, fmt.Errorf("unknown analyzer %q", lang)
}

// ReadDoc decodes and validates an IR file, writing every validation problem to log.
func ReadDoc(path string, log io.Writer) (*ir.Document, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	doc, err := ir.Decode(f)
	if err != nil {
		return nil, err
	}
	if err := doc.Validate(); err != nil {
		var ve *ir.ValidationError
		if errors.As(err, &ve) {
			for _, p := range ve.Problems {
				fmt.Fprintln(log, "  -", p)
			}
		}
		return nil, err
	}
	return doc, nil
}

func Short(sha string) string {
	if len(sha) > 10 {
		return sha[:10]
	}
	return sha
}
