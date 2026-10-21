package auth

import (
	"strings"
	"testing"
)

func TestPasswordRoundTrip(t *testing.T) {
	h, err := HashPassword("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	if !CheckPassword(h, "correct horse battery") {
		t.Error("correct password rejected")
	}
	if CheckPassword(h, "wrong horse battery") {
		t.Error("wrong password accepted")
	}
	if CheckPassword("", "anything at all") {
		t.Error("empty hash accepted")
	}
}

func TestPasswordLength(t *testing.T) {
	for _, p := range []string{"short", strings.Repeat("x", 73)} {
		if _, err := HashPassword(p); err != ErrPasswordLength {
			t.Errorf("len %d: want ErrPasswordLength, got %v", len(p), err)
		}
	}
}

func TestNewToken(t *testing.T) {
	a, ha, err := NewToken()
	if err != nil {
		t.Fatal(err)
	}
	b, _, _ := NewToken()
	if a == b {
		t.Fatal("tokens repeat")
	}
	if !strings.HasPrefix(a, tokenPrefix) {
		t.Errorf("missing prefix: %s", a)
	}
	if HashToken(a) != ha {
		t.Error("hash mismatch")
	}
}
