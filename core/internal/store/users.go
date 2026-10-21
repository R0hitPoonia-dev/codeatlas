package store

import (
	"context"
	"strings"
	"time"
)

type Role string

const (
	RoleAdmin  Role = "admin"
	RoleMember Role = "member"
)

func (r Role) Valid() bool { return r == RoleAdmin || r == RoleMember }

type User struct {
	ID           string    `json:"id"`
	Email        string    `json:"email"`
	Role         Role      `json:"role"`
	CreatedAt    time.Time `json:"createdAt"`
	PasswordHash string    `json:"-"`
}

type TokenKind string

const (
	TokenSession TokenKind = "session"
	TokenAPI     TokenKind = "api"
)

const userCols = "id, email, role, created_at, password_hash"

func scanUser(row interface{ Scan(...any) error }) (*User, error) {
	var u User
	if err := row.Scan(&u.ID, &u.Email, &u.Role, &u.CreatedAt, &u.PasswordHash); err != nil {
		return nil, notFound(err)
	}
	return &u, nil
}

func normalizeEmail(email string) string { return strings.ToLower(strings.TrimSpace(email)) }

func (s *Store) CreateUser(ctx context.Context, email, passwordHash string, role Role) (*User, error) {
	u, err := scanUser(s.pool.QueryRow(ctx,
		"INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING "+userCols,
		normalizeEmail(email), passwordHash, role))
	if isUniqueViolation(err) {
		return nil, ErrConflict
	}
	return u, err
}

func (s *Store) UserByEmail(ctx context.Context, email string) (*User, error) {
	return scanUser(s.pool.QueryRow(ctx, "SELECT "+userCols+" FROM users WHERE email = $1", normalizeEmail(email)))
}

func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.pool.Query(ctx, "SELECT "+userCols+" FROM users ORDER BY created_at")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	users := []User{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		users = append(users, *u)
	}
	return users, rows.Err()
}

func (s *Store) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, "SELECT count(*) FROM users").Scan(&n)
	return n, err
}

// CreateToken stores the hash of a session or API token. A nil expiresAt never expires.
func (s *Store) CreateToken(ctx context.Context, tokenHash, userID string, kind TokenKind, name string, expiresAt *time.Time) error {
	_, err := s.pool.Exec(ctx,
		"INSERT INTO tokens (token_hash, user_id, kind, name, expires_at) VALUES ($1, $2, $3, NULLIF($4, ''), $5)",
		tokenHash, userID, kind, name, expiresAt)
	return err
}

// UserByToken resolves an unexpired token to its user and records its use.
func (s *Store) UserByToken(ctx context.Context, tokenHash string) (*User, TokenKind, error) {
	var kind TokenKind
	var u User
	err := s.pool.QueryRow(ctx, `
		UPDATE tokens t SET last_used_at = now()
		FROM users u
		WHERE t.token_hash = $1 AND t.user_id = u.id AND (t.expires_at IS NULL OR t.expires_at > now())
		RETURNING u.id, u.email, u.role, u.created_at, u.password_hash, t.kind`, tokenHash).
		Scan(&u.ID, &u.Email, &u.Role, &u.CreatedAt, &u.PasswordHash, &kind)
	if err != nil {
		return nil, "", notFound(err)
	}
	return &u, kind, nil
}

func (s *Store) DeleteToken(ctx context.Context, tokenHash string) error {
	_, err := s.pool.Exec(ctx, "DELETE FROM tokens WHERE token_hash = $1", tokenHash)
	return err
}

// DeleteExpiredTokens removes expired sessions; returns how many were removed.
func (s *Store) DeleteExpiredTokens(ctx context.Context) (int64, error) {
	tag, err := s.pool.Exec(ctx, "DELETE FROM tokens WHERE expires_at IS NOT NULL AND expires_at <= now()")
	return tag.RowsAffected(), err
}
