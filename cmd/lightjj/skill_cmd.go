package main

import (
	_ "embed"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// SKILL.md teaches an agent harness (Claude Code, etc.) how to use `lightjj
// api`. Embedded so `lightjj skill install` works from the binary alone — the
// repo source isn't on every machine that has lightjj installed.
//
// Co-located with this file rather than in a top-level skills/ dir because the
// embed directive can't reference parent directories. `lightjj skill install`
// is the canonical install path; for live-reload dev workflows, symlink the
// file: `mkdir -p ~/.claude/skills/lightjj && ln -s $(pwd)/cmd/lightjj/SKILL.md
// ~/.claude/skills/lightjj/SKILL.md`.
//
//go:embed SKILL.md
var skillMD string

// skillMarker is the string we expect at the top of any SKILL.md we wrote.
// Used to refuse clobbering a file that came from a different skill — `install`
// without --force only overwrites our own previous install.
const skillMarker = "name: lightjj"

const skillUsage = `usage: lightjj skill [install [flags]]

  lightjj skill                  print SKILL.md to stdout
  lightjj skill install          write SKILL.md to ~/.claude/skills/lightjj/
  lightjj skill install --dir D  write SKILL.md to D/SKILL.md

flags (install):
  --dir    destination directory (default: ~/.claude/skills/lightjj)
  --force  overwrite even if the existing file doesn't look like ours

The skill teaches agent harnesses to use 'lightjj api' for reading diffs,
posting review comments, and steering the user's view. Once installed,
harnesses that scan ~/.claude/skills/ pick it up automatically.
`

// runSkillSubcommand implements `lightjj skill [install]`. Returns process exit
// code: 0 success, 1 write error, 2 usage error.
func runSkillSubcommand(args []string) int {
	if len(args) == 0 {
		// Bare `lightjj skill` — print to stdout so users can pipe it
		// (`lightjj skill > .claude/skills/lightjj/SKILL.md` for project-local
		// install, or just inspect it before installing).
		fmt.Print(skillMD)
		return 0
	}
	if args[0] != "install" {
		fmt.Fprintf(os.Stderr, "lightjj skill: unknown subcommand %q\n\n%s", args[0], skillUsage)
		return 2
	}

	fs := flag.NewFlagSet("skill install", flag.ContinueOnError)
	fs.SetOutput(io.Discard) // we print our own usage on parse error
	var dir string
	var force bool
	fs.StringVar(&dir, "dir", "", "destination directory")
	fs.BoolVar(&force, "force", false, "overwrite even if existing file doesn't look like a lightjj SKILL.md")
	if err := fs.Parse(args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "lightjj skill install: %v\n\n%s", err, skillUsage)
		return 2
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "lightjj skill install: unexpected argument %q\n\n%s", fs.Arg(0), skillUsage)
		return 2
	}

	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			fmt.Fprintf(os.Stderr, "lightjj skill install: cannot determine home directory: %v\n", err)
			return 1
		}
		dir = filepath.Join(home, ".claude", "skills", "lightjj")
	}

	if code := installSkill(dir, force, os.Stderr); code != 0 {
		return code
	}
	fmt.Fprintf(os.Stderr, "installed %s\n", filepath.Join(dir, "SKILL.md"))
	return 0
}

// installSkill writes skillMD to dir/SKILL.md, creating dir if needed. Refuses
// to overwrite a file that doesn't contain skillMarker unless force is set —
// guards against clobbering a different tool's skill that happens to be named
// "lightjj". Returns process exit code.
func installSkill(dir string, force bool, errOut io.Writer) int {
	target := filepath.Join(dir, "SKILL.md")

	// Refuse-to-clobber check: read the existing file (if any) and look for
	// our marker. Missing file → install. Our marker → re-install (upgrade).
	// Foreign content → refuse unless --force.
	if existing, err := os.ReadFile(target); err == nil {
		if !strings.Contains(string(existing), skillMarker) && !force {
			fmt.Fprintf(errOut,
				"lightjj skill install: %s exists and doesn't look like a lightjj SKILL.md; use --force to overwrite\n",
				target)
			return 1
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		fmt.Fprintf(errOut, "lightjj skill install: cannot read %s: %v\n", target, err)
		return 1
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		fmt.Fprintf(errOut, "lightjj skill install: %v\n", err)
		return 1
	}
	if err := os.WriteFile(target, []byte(skillMD), 0o644); err != nil {
		fmt.Fprintf(errOut, "lightjj skill install: %v\n", err)
		return 1
	}
	return 0
}
