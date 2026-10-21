// Package gitprofiles manages git profiles (who commits, which SSH key authenticates) in the
// same file the terminal helper uses (~/.git-profiles: "name|user name|email|ssh key" per
// line), so a profile added in the UI is also offered by `gitprofile` in a terminal. The
// server clones a repo with its profile's SSH key; private keys never leave the server.
package gitprofiles

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type Profile struct {
	Name     string `json:"name"`
	UserName string `json:"userName"`
	Email    string `json:"email"`
	// KeyPath as written in the file (may start with ~/).
	KeyPath   string `json:"keyPath"`
	KeyExists bool   `json:"keyExists"`
	PublicKey string `json:"publicKey,omitempty"`
}

var (
	ErrNotFound = errors.New("no such git profile")
	ErrExists   = errors.New("a git profile with this name already exists")
)

// Invalid is a validation error, safe to show to the user.
type Invalid struct{ Msg string }

func (e *Invalid) Error() string { return e.Msg }

var (
	nameRe  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$`)
	emailRe = regexp.MustCompile(`^[^@\s|]+@[^@\s|]+$`)
)

type Store struct {
	file    string // the profiles file
	keysDir string // where generated keys go, and the only place existing keys may come from
	home    string
	mu      sync.Mutex
}

// New uses file (default ~/.git-profiles) and keysDir (default ~/.ssh).
func New(file, keysDir string) *Store {
	home, _ := os.UserHomeDir()
	if file == "" {
		file = filepath.Join(home, ".git-profiles")
	}
	if keysDir == "" {
		keysDir = filepath.Join(home, ".ssh")
	}
	return &Store{file: file, keysDir: keysDir, home: home}
}

func (s *Store) expand(p string) string {
	if strings.HasPrefix(p, "~/") {
		return filepath.Join(s.home, p[2:])
	}
	return p
}

// List returns the profiles in file order. A missing file means no profiles.
func (s *Store) List() ([]Profile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.list()
}

func (s *Store) list() ([]Profile, error) {
	f, err := os.Open(s.file)
	if errors.Is(err, os.ErrNotExist) {
		return []Profile{}, nil
	} else if err != nil {
		return nil, err
	}
	defer f.Close()
	out := []Profile{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.Split(line, "|")
		if len(parts) < 4 {
			continue
		}
		p := Profile{Name: strings.TrimSpace(parts[0]), UserName: strings.TrimSpace(parts[1]),
			Email: strings.TrimSpace(parts[2]), KeyPath: strings.TrimSpace(parts[3])}
		key := s.expand(p.KeyPath)
		if st, err := os.Stat(key); err == nil && st.Mode().IsRegular() {
			p.KeyExists = true
		}
		if pub, err := os.ReadFile(key + ".pub"); err == nil {
			p.PublicKey = strings.TrimSpace(string(pub))
		}
		out = append(out, p)
	}
	return out, sc.Err()
}

func (s *Store) Get(name string) (*Profile, error) {
	ps, err := s.List()
	if err != nil {
		return nil, err
	}
	for _, p := range ps {
		if p.Name == name {
			return &p, nil
		}
	}
	return nil, ErrNotFound
}

// KeyFile is the absolute path of the profile's private key.
func (s *Store) KeyFile(p *Profile) string { return s.expand(p.KeyPath) }

// Add appends a profile. With generate, a new ed25519 key (no passphrase) is created in
// keysDir as id_ed25519_<name>; otherwise keyPath must name an existing private key in keysDir.
func (s *Store) Add(ctx context.Context, p Profile, generate bool) (*Profile, error) {
	p.Name, p.UserName, p.Email = strings.TrimSpace(p.Name), strings.TrimSpace(p.UserName), strings.TrimSpace(p.Email)
	switch {
	case !nameRe.MatchString(p.Name):
		return nil, &Invalid{"profile name: 1-40 letters, digits, '-' or '_'"}
	case p.UserName == "" || strings.ContainsAny(p.UserName, "|\r\n") || len(p.UserName) > 100:
		return nil, &Invalid{"name: 1-100 characters, no '|'"}
	case !emailRe.MatchString(p.Email):
		return nil, &Invalid{"invalid email"}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	existing, err := s.list()
	if err != nil {
		return nil, err
	}
	for _, e := range existing {
		if strings.EqualFold(e.Name, p.Name) {
			return nil, ErrExists
		}
	}

	var key string
	if generate {
		key = filepath.Join(s.keysDir, "id_ed25519_"+strings.ToLower(p.Name))
		if _, err := os.Stat(key); err == nil {
			return nil, &Invalid{fmt.Sprintf("%s already exists; choose \"use an existing key\" or another name", s.tilde(key))}
		}
		if err := os.MkdirAll(s.keysDir, 0o700); err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, "ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", p.Email, "-f", key).CombinedOutput()
		if err != nil {
			return nil, fmt.Errorf("ssh-keygen: %v: %s", err, bytes.TrimSpace(out))
		}
	} else {
		key = filepath.Clean(s.expand(strings.TrimSpace(p.KeyPath)))
		dir, _ := filepath.Abs(s.keysDir)
		abs, _ := filepath.Abs(key)
		if filepath.Dir(abs) != dir {
			return nil, &Invalid{fmt.Sprintf("the key must be a file directly in %s", s.tilde(s.keysDir))}
		}
		if st, err := os.Stat(abs); err != nil || !st.Mode().IsRegular() || strings.HasSuffix(abs, ".pub") {
			return nil, &Invalid{fmt.Sprintf("no private key at %s", s.tilde(abs))}
		}
		key = abs
	}
	p.KeyPath = s.tilde(key)

	if err := s.appendLine(p); err != nil {
		return nil, err
	}
	p.KeyExists = true
	if pub, err := os.ReadFile(key + ".pub"); err == nil {
		p.PublicKey = strings.TrimSpace(string(pub))
	}
	return &p, nil
}

func (s *Store) appendLine(p Profile) error {
	_, statErr := os.Stat(s.file)
	f, err := os.OpenFile(s.file, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	var b strings.Builder
	if errors.Is(statErr, os.ErrNotExist) {
		b.WriteString("# Git profiles, one per line:  profile | your name | email | SSH key\n")
	} else if data, err := os.ReadFile(s.file); err == nil && len(data) > 0 && data[len(data)-1] != '\n' {
		b.WriteString("\n")
	}
	fmt.Fprintf(&b, "%s|%s|%s|%s\n", p.Name, p.UserName, p.Email, p.KeyPath)
	_, err = f.WriteString(b.String())
	return err
}

// tilde writes paths under the home directory as ~/..., like the hand-written lines.
func (s *Store) tilde(p string) string {
	if s.home != "" && strings.HasPrefix(p, s.home+string(filepath.Separator)) {
		return "~/" + p[len(s.home)+1:]
	}
	return p
}

// SSHCommand is the GIT_SSH_COMMAND that authenticates as this profile without prompting.
func (s *Store) SSHCommand(p *Profile) string {
	return fmt.Sprintf("ssh -i %s -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
		shellQuote(s.KeyFile(p)))
}

var greeting = regexp.MustCompile(`Hi ([A-Za-z0-9-]+)!`)

// Test logs in to host (github.com) with the profile's key and returns the account it
// authenticates as ("" with the server's message when it does not).
func (s *Store) Test(ctx context.Context, name, host string) (account, message string, err error) {
	p, err := s.Get(name)
	if err != nil {
		return "", "", err
	}
	if !p.KeyExists {
		return "", "the key file " + p.KeyPath + " does not exist", nil
	}
	if host == "" {
		host = "github.com"
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ssh", "-T", "-i", s.KeyFile(p), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
		"-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10", "git@"+host)
	out, _ := cmd.CombinedOutput() // GitHub exits 1 even when the key is accepted
	text := strings.TrimSpace(string(out))
	if m := greeting.FindStringSubmatch(text); m != nil {
		return m[1], text, nil
	}
	if ctx.Err() != nil {
		return "", "timed out connecting to " + host, nil
	}
	return "", text, nil
}

func shellQuote(s string) string {
	if regexp.MustCompile(`^[A-Za-z0-9_./~-]+$`).MatchString(s) {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
