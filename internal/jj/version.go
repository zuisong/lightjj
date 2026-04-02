package jj

import (
	"regexp"
	"strconv"
)

// Semver is a parsed jj version (major, minor). Patch is dropped — feature
// gates only care about minor releases (jj's feature cadence). Named Semver
// not Version because Version() is the `jj --version` command builder.
type Semver [2]int

// Feature gates. Each names the FIRST jj release that supports the capability.
// Backend handlers call s.jjSupports(ctx, jj.WorkspaceRootTmpl) to pick between
// a new codepath and a proven fallback. Keep this list small — only add an
// entry when the backend actually branches on it; frontend-only gates live in
// frontend/src/lib/jj-features.svelte.ts.
var (
	// WorkspaceRootTmpl: WorkspaceRef.root() template method. Lets the
	// workspace-list template emit absolute paths directly, replacing the
	// hand-rolled protobuf parser of .jj/repo/workspace_store/index (which
	// is additive-only — pre-existing workspaces have no entry).
	WorkspaceRootTmpl = Semver{0, 40}
)

var versionRe = regexp.MustCompile(`(\d+)\.(\d+)`)

// ParseSemver extracts (major, minor) from `jj --version` output, e.g.
// "jj 0.39.0" → {0,39}. Tolerates suffixes like "-nightly+abc" (regex anchors
// on the first N.N). Second return is false on no match.
func ParseSemver(s string) (Semver, bool) {
	m := versionRe.FindStringSubmatch(s)
	if m == nil {
		return Semver{}, false
	}
	maj, _ := strconv.Atoi(m[1])
	min, _ := strconv.Atoi(m[2])
	return Semver{maj, min}, true
}

// AtLeast reports whether v >= min.
func (v Semver) AtLeast(min Semver) bool {
	return v[0] > min[0] || (v[0] == min[0] && v[1] >= min[1])
}
