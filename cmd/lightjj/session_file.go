package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// Runtime session metadata for agent discovery. Written after net.Listen binds
// so agents can find a running lightjj by repo path instead of port. The
// localhost-only middleware (main.go localhostOnly) is the security boundary;
// this file just makes the port discoverable to local processes.

type sessionInfo struct {
	PID       int    `json:"pid"`
	Addr      string `json:"addr"`     // listener.Addr().String() — "127.0.0.1:NNNNN"
	Port      int    `json:"port"`     // parsed for convenience
	RepoDir   string `json:"repo_dir"` // resolved local path, or remote path in --remote mode
	Mode      string `json:"mode"`     // "local" or "ssh"
	StartedAt int64  `json:"started_at"`
}

// sessionDir resolves the runtime sessions directory: $XDG_RUNTIME_DIR/lightjj/sessions
// where set (Linux desktop), else os.TempDir()/lightjj-<uid>/sessions. Created
// 0700 so other local users can't read the port (which grants API control).
//
// On the TempDir fallback, the base path is verified to be a real directory
// owned by us — sticky /tmp lets any user pre-create /tmp/lightjj-<victim-uid>
// and plant a sessions/<pid>.json symlink, which os.WriteFile would follow.
// XDG_RUNTIME_DIR is already user-owned by spec, so the check is skipped there.
func sessionDir() (string, error) {
	var base string
	verify := false
	if x := os.Getenv("XDG_RUNTIME_DIR"); x != "" {
		base = filepath.Join(x, "lightjj")
	} else {
		base = filepath.Join(os.TempDir(), fmt.Sprintf("lightjj-%d", os.Getuid()))
		verify = true
	}
	// Verify base BEFORE MkdirAll so a pre-existing symlink isn't followed into
	// attacker-controlled space. ENOENT → fine, we create it.
	if verify {
		if err := verifyOwnedDir(base); err != nil && !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
	}
	dir := filepath.Join(base, "sessions")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if verify {
		// Re-verify post-create: confirms MkdirAll didn't widen perms (umask)
		// and that sessions/ itself wasn't pre-planted inside a legit base.
		if err := verifyOwnedDir(base); err != nil {
			return "", err
		}
		if err := verifyOwnedDir(dir); err != nil {
			return "", err
		}
	}
	return dir, nil
}

// verifyOwnedDir checks that path is a real directory (not a symlink) with no
// group/other permission bits, owned by the current user (uid check is in
// session_file_unix.go — Stat_t doesn't exist on Windows). Guards against a
// hostile user pre-creating the TempDir-fallback path.
func verifyOwnedDir(path string) error {
	fi, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !fi.IsDir() || fi.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("session dir %s is not a plain directory", path)
	}
	if fi.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("session dir %s has group/other permissions", path)
	}
	return verifyOwner(path, fi)
}

// pidAlive: signal-0 probe. nil or EPERM ⇒ alive; ESRCH ⇒ dead.
func pidAlive(pid int) bool {
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = p.Signal(syscall.Signal(0))
	return err == nil || errors.Is(err, syscall.EPERM)
}

// sweepStaleSessions removes <pid>.json files whose pid is no longer running.
// Best-effort: a concurrent instance may sweep the same entry; the dir may not
// exist on first run.
func sweepStaleSessions(dir string) {
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".json") {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSuffix(name, ".json"))
		if err != nil || pidAlive(pid) {
			continue
		}
		_ = os.Remove(filepath.Join(dir, name))
	}
}

// writeSessionFile writes the metadata file and returns its path for cleanup.
// Sweeps stale entries first so crashes don't accumulate. Non-fatal on error —
// agent discovery is best-effort; the server still works.
func writeSessionFile(info sessionInfo) string {
	dir, err := sessionDir()
	if err != nil {
		return ""
	}
	sweepStaleSessions(dir)
	path := filepath.Join(dir, fmt.Sprintf("%d.json", info.PID))
	js, _ := json.Marshal(info)
	if err := os.WriteFile(path, js, 0o600); err != nil {
		return ""
	}
	return path
}
