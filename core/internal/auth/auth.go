// Package auth holds password hashing and opaque token helpers.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"

	"golang.org/x/crypto/bcrypt"
)

const (
	MinPasswordLen = 12
	// bcrypt only uses the first 72 bytes; reject longer input rather than silently truncating.
	MaxPasswordLen = 72
	tokenPrefix    = "cat_"
)

var ErrPasswordLength = errors.New("password must be 12-72 bytes")

func HashPassword(password string) (string, error) {
	if len(password) < MinPasswordLen || len(password) > MaxPasswordLen {
		return "", ErrPasswordLength
	}
	h, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	return string(h), err
}

// dummyHash is compared against when a user doesn't exist, so lookups of unknown
// emails take as long as real ones.
var dummyHash, _ = bcrypt.GenerateFromPassword([]byte("codeatlas-dummy-password"), bcrypt.DefaultCost)

// CheckPassword reports whether password matches hash. Pass an empty hash for an
// unknown user; it still spends the bcrypt time and returns false.
func CheckPassword(hash, password string) bool {
	if hash == "" {
		bcrypt.CompareHashAndPassword(dummyHash, []byte(password))
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

// NewToken returns a random bearer token and the hash to store for it.
func NewToken() (token, hash string, err error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", "", err
	}
	token = tokenPrefix + base64.RawURLEncoding.EncodeToString(b)
	return token, HashToken(token), nil
}

// HashToken is the lookup key stored in the database. Tokens carry 256 bits of
// entropy, so an unsalted SHA-256 is sufficient.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
