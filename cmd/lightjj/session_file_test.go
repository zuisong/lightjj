package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSessionFileRoundTrip(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())

	info := sessionInfo{
		PID:       os.Getpid(),
		Addr:      "127.0.0.1:54321",
		Port:      54321,
		RepoDir:   "/home/user/repo",
		Mode:      "local",
		StartedAt: 1234567890,
	}
	path := writeSessionFile(info)
	require.NotEmpty(t, path)
	t.Cleanup(func() { os.Remove(path) })

	data, err := os.ReadFile(path)
	require.NoError(t, err)
	var got sessionInfo
	require.NoError(t, json.Unmarshal(data, &got))
	assert.Equal(t, info, got)

	st, err := os.Stat(path)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o600), st.Mode().Perm())
}

func TestSweepStaleSessions(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", tmp)
	dir, err := sessionDir()
	require.NoError(t, err)

	live := filepath.Join(dir, fmt.Sprintf("%d.json", os.Getpid()))
	require.NoError(t, os.WriteFile(live, []byte("{}"), 0o600))
	// PID 1 init/launchd is always alive on Unix; pick something guaranteed
	// dead by writing our own pid +1e6 (well beyond pid_max).
	dead := filepath.Join(dir, "999999999.json")
	require.NoError(t, os.WriteFile(dead, []byte("{}"), 0o600))
	notJSON := filepath.Join(dir, "garbage.txt")
	require.NoError(t, os.WriteFile(notJSON, []byte("x"), 0o600))

	sweepStaleSessions(dir)

	assert.FileExists(t, live, "live pid file should survive")
	assert.NoFileExists(t, dead, "dead pid file should be removed")
	assert.FileExists(t, notJSON, "non-json files should be ignored")
}

func TestPidAlive(t *testing.T) {
	assert.True(t, pidAlive(os.Getpid()))
	assert.False(t, pidAlive(999999999))
}

func TestVerifyOwnedDir(t *testing.T) {
	tmp := t.TempDir()

	tight := filepath.Join(tmp, "tight")
	require.NoError(t, os.Mkdir(tight, 0o700))
	require.NoError(t, os.Chmod(tight, 0o700)) // umask may have widened it
	assert.NoError(t, verifyOwnedDir(tight))

	loose := filepath.Join(tmp, "loose")
	require.NoError(t, os.Mkdir(loose, 0o777))
	require.NoError(t, os.Chmod(loose, 0o755))
	assert.ErrorContains(t, verifyOwnedDir(loose), "group/other")

	link := filepath.Join(tmp, "link")
	require.NoError(t, os.Symlink(tight, link))
	assert.ErrorContains(t, verifyOwnedDir(link), "not a plain directory")
}
