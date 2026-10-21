package gitprofiles

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newStore(t *testing.T, content string) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	file := filepath.Join(dir, "profiles")
	if content != "" {
		os.WriteFile(file, []byte(content), 0o644)
	}
	keys := filepath.Join(dir, "ssh")
	os.MkdirAll(keys, 0o700)
	return New(file, keys), keys
}

func TestListReadsTheTerminalHelpersFormat(t *testing.T) {
	s, keys := newStore(t, "# comment\n\nwork|Rohit|r@work.com|"+filepath.Join("KEYS", "id_work")+"\nbroken line\n")
	os.WriteFile(filepath.Join(s.file), []byte(strings.ReplaceAll(mustRead(t, s.file), "KEYS", keys)), 0o644)
	os.WriteFile(filepath.Join(keys, "id_work"), []byte("private"), 0o600)
	os.WriteFile(filepath.Join(keys, "id_work.pub"), []byte("ssh-ed25519 AAAA r@work.com\n"), 0o644)
	ps, err := s.List()
	if err != nil || len(ps) != 1 {
		t.Fatalf("list = %+v, %v", ps, err)
	}
	p := ps[0]
	if p.Name != "work" || p.Email != "r@work.com" || !p.KeyExists || p.PublicKey != "ssh-ed25519 AAAA r@work.com" {
		t.Fatalf("profile = %+v", p)
	}
	if _, err := s.Get("nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get missing: %v", err)
	}
}

func TestAddGeneratesAKeyAndAppends(t *testing.T) {
	s, keys := newStore(t, "work|Rohit|r@work.com|~/.ssh/id_work") // no trailing newline
	p, err := s.Add(context.Background(), Profile{Name: "oss", UserName: "Rohit P", Email: "r@oss.dev"}, true)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(p.PublicKey, "ssh-ed25519 ") || !strings.HasSuffix(p.PublicKey, "r@oss.dev") {
		t.Fatalf("public key = %q", p.PublicKey)
	}
	st, err := os.Stat(filepath.Join(keys, "id_ed25519_oss"))
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("private key: %v %v", st, err)
	}
	lines := strings.Split(strings.TrimSpace(mustRead(t, s.file)), "\n")
	if len(lines) != 2 || !strings.HasPrefix(lines[1], "oss|Rohit P|r@oss.dev|") {
		t.Fatalf("file = %q", lines)
	}
	if _, err := s.Add(context.Background(), Profile{Name: "OSS", UserName: "x", Email: "x@y.z"}, true); !errors.Is(err, ErrExists) {
		t.Fatalf("duplicate: %v", err)
	}
}

func TestAddValidates(t *testing.T) {
	s, keys := newStore(t, "")
	ctx := context.Background()
	for _, p := range []Profile{
		{Name: "a b", UserName: "x", Email: "x@y.z"},
		{Name: "ok", UserName: "x|y", Email: "x@y.z"},
		{Name: "ok", UserName: "x", Email: "not-an-email"},
		{Name: "ok", UserName: "x", Email: "x@y.z", KeyPath: "/etc/passwd"},
		{Name: "ok", UserName: "x", Email: "x@y.z", KeyPath: filepath.Join(keys, "missing")},
	} {
		var inv *Invalid
		if _, err := s.Add(ctx, p, p.KeyPath == "" && p.Name != "ok"); !errors.As(err, &inv) {
			t.Errorf("%+v: err = %v", p, err)
		}
	}
	// an existing key in the keys dir is accepted; the file is created with a header
	os.WriteFile(filepath.Join(keys, "id_existing"), []byte("private"), 0o600)
	p, err := s.Add(ctx, Profile{Name: "ok", UserName: "x", Email: "x@y.z", KeyPath: filepath.Join(keys, "id_existing")}, false)
	if err != nil || !p.KeyExists {
		t.Fatalf("existing key: %+v %v", p, err)
	}
	if !strings.HasPrefix(mustRead(t, s.file), "# Git profiles") {
		t.Fatal("new file has no header")
	}
}

func mustRead(t *testing.T, f string) string {
	t.Helper()
	b, err := os.ReadFile(f)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
