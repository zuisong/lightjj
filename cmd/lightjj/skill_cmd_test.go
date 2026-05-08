package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSkillEmbedNonEmpty(t *testing.T) {
	require.NotEmpty(t, skillMD, "go:embed of SKILL.md produced empty string")
	// The marker is what `install` uses to recognize its own previous output —
	// if the SKILL.md frontmatter changes, this test catches the desync.
	assert.Contains(t, skillMD, skillMarker)
	// Self-consistency: the skill must teach the CLI it ships with.
	assert.Contains(t, skillMD, "lightjj api")
	assert.Contains(t, skillMD, "lightjj sessions")
	assert.Contains(t, skillMD, "/api/agent")
}

func TestInstallSkill(t *testing.T) {
	t.Run("fresh install", func(t *testing.T) {
		dir := filepath.Join(t.TempDir(), "skills", "lightjj")
		code := installSkill(dir, false, os.Stderr)
		require.Equal(t, 0, code)
		got, err := os.ReadFile(filepath.Join(dir, "SKILL.md"))
		require.NoError(t, err)
		assert.Equal(t, skillMD, string(got))
	})

	t.Run("re-install overwrites our own", func(t *testing.T) {
		dir := t.TempDir()
		require.NoError(t, os.WriteFile(filepath.Join(dir, "SKILL.md"),
			[]byte("---\nname: lightjj\n---\nold version"), 0o644))
		code := installSkill(dir, false, os.Stderr)
		require.Equal(t, 0, code)
		got, _ := os.ReadFile(filepath.Join(dir, "SKILL.md"))
		assert.Equal(t, skillMD, string(got), "re-install should upgrade in place")
	})

	t.Run("refuses foreign content without --force", func(t *testing.T) {
		dir := t.TempDir()
		require.NoError(t, os.WriteFile(filepath.Join(dir, "SKILL.md"),
			[]byte("---\nname: some-other-tool\n---\n"), 0o644))
		var errBuf strings.Builder
		code := installSkill(dir, false, &errBuf)
		assert.Equal(t, 1, code)
		assert.Contains(t, errBuf.String(), "doesn't look like a lightjj SKILL.md")
		// Original content untouched.
		got, _ := os.ReadFile(filepath.Join(dir, "SKILL.md"))
		assert.Contains(t, string(got), "some-other-tool")
	})

	t.Run("--force overwrites foreign content", func(t *testing.T) {
		dir := t.TempDir()
		require.NoError(t, os.WriteFile(filepath.Join(dir, "SKILL.md"),
			[]byte("not ours"), 0o644))
		code := installSkill(dir, true, os.Stderr)
		require.Equal(t, 0, code)
		got, _ := os.ReadFile(filepath.Join(dir, "SKILL.md"))
		assert.Equal(t, skillMD, string(got))
	})
}

func TestRunSkillSubcommand(t *testing.T) {
	t.Run("unknown subcommand exits 2", func(t *testing.T) {
		assert.Equal(t, 2, runSkillSubcommand([]string{"bogus"}))
	})
	t.Run("install with extra positional exits 2", func(t *testing.T) {
		assert.Equal(t, 2, runSkillSubcommand([]string{"install", "extra"}))
	})
	t.Run("install --dir writes file", func(t *testing.T) {
		dir := filepath.Join(t.TempDir(), "lightjj")
		assert.Equal(t, 0, runSkillSubcommand([]string{"install", "--dir", dir}))
		_, err := os.Stat(filepath.Join(dir, "SKILL.md"))
		assert.NoError(t, err)
	})
	// Bare `lightjj skill` writes to stdout — exit code is the contract here;
	// stdout-capture not worth the os.Pipe plumbing for a static embed dump.
	t.Run("bare prints exits 0", func(t *testing.T) {
		assert.Equal(t, 0, runSkillSubcommand(nil))
	})
}
