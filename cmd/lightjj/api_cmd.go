package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"
)

// CLI subcommands for agent harnesses with curl/wget denylisted in their Bash
// sandbox. `lightjj api METHOD PATH [BODY]` makes an HTTP request via Go's
// net/http to a discovered local lightjj instance; `lightjj sessions` lists
// running instances. See docs/design-notes/api-cli.md for the security model
// and discovery algorithm.

// headerSlice is a repeatable -H "Key: Value" flag value.
type headerSlice []string

func (h *headerSlice) String() string { return strings.Join(*h, ", ") }
func (h *headerSlice) Set(v string) error {
	*h = append(*h, v)
	return nil
}

// validateAddr parses and validates a host:port address. The host must be
// loopback (127.0.0.1, ::1, or localhost) and the port must be 1..65535.
// Both checks are load-bearing: net.SplitHostPort("127.0.0.1:80@evil.com")
// returns (host="127.0.0.1", port="80@evil.com", err=nil) — the strconv check
// rejects it, not the host check. See Security model §2 in api-cli.md.
func validateAddr(addr string) (host, port string, err error) {
	host, port, err = net.SplitHostPort(addr)
	if err != nil {
		return "", "", fmt.Errorf("invalid address %q: %v", addr, err)
	}
	switch host {
	case "127.0.0.1", "::1", "localhost":
		// ok
	default:
		return "", "", fmt.Errorf("address %q is not loopback (must be 127.0.0.1, ::1, or localhost)", addr)
	}
	n, perr := strconv.Atoi(port)
	if perr != nil || n < 1 || n > 65535 {
		return "", "", fmt.Errorf("invalid port %q in address %q", port, addr)
	}
	// Return the canonical port, not the raw string — Atoi accepts "080" and
	// "+80", which downstream parsers (url.Parse) may handle differently.
	// Validate-then-use-original is the textbook parser-mismatch bug shape.
	return host, strconv.Itoa(n), nil
}

// containsPath reports whether resolvedCwd is inside (or equal to)
// resolvedRepoDir. Both paths must already be EvalSymlinks-resolved. The check
// is component-aware (filepath.Rel), not byte-prefix — `/a/..foo` is *inside*
// `/a`; `/a/foobar` is not inside `/a/foo`.
func containsPath(resolvedRepoDir, resolvedCwd string) bool {
	rel, err := filepath.Rel(resolvedRepoDir, resolvedCwd)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// candidate pairs a session with its resolved RepoDir (for sorting and tie
// detection).
type candidate struct {
	sess     sessionInfo
	resolved string
}

// discoverSession finds the most-specific running local lightjj instance whose
// RepoDir contains repoPath. Implements the 7-step discovery algorithm in
// docs/design-notes/api-cli.md. dir is taken as a parameter (not resolved
// internally) so tests can pass t.TempDir().
func discoverSession(dir, repoPath string) (sessionInfo, error) {
	// Step 1: read + size-cap + schema filter.
	sessions, err := readSessions(dir)
	if err != nil {
		return sessionInfo{}, fmt.Errorf("reading sessions: %w", err)
	}

	// Resolve repoPath once. Abs FIRST, then EvalSymlinks — EvalSymlinks of a
	// relative path returns a relative result without erroring, so an "Abs as
	// fallback" never fires and a relative `--repo .` would silently match
	// nothing (filepath.Rel against an absolute RepoDir errors → no match).
	// EvalSymlinks both sides so the matcher is independent of whether
	// `jj workspace root` (the RepoDir producer) resolves symlinks.
	if abs, aerr := filepath.Abs(repoPath); aerr == nil {
		repoPath = abs
	}
	resolvedCwd, rerr := filepath.EvalSymlinks(repoPath)
	if rerr != nil {
		// cwd deleted or perms — fall back to the unresolved absolute path.
		resolvedCwd = repoPath
		if !filepath.IsAbs(resolvedCwd) {
			return sessionInfo{}, errors.New("cannot determine working directory")
		}
	}

	var alive []sessionInfo // for the zero-match error message (incl. SSH)
	var matches []candidate

	for _, s := range sessions {
		// Step 1 (continued): pre-filter RepoDir before any resolution.
		// "/" is rejected because it would universally match any cwd. A
		// single-component path like "/Users" or "/home" is one level less
		// universal and is NOT rejected — it's constrained by the dir trust
		// boundary (planted entries require same-uid + a verified-owned dir),
		// and "longest RepoDir wins" prefers any real session over it.
		cleaned := filepath.Clean(s.RepoDir)
		if cleaned == "" || cleaned == "/" || !filepath.IsAbs(cleaned) {
			continue
		}
		// Step 2: filter dead pids — freshness, not trust (Security §3).
		if !pidAlive(s.PID) {
			continue
		}
		alive = append(alive, s)
		// Step 3: filter Mode == "local". An SSH-mode RepoDir holds the
		// *remote* path; if it coincidentally exists locally, a containment
		// match would route the agent's writes to the wrong machine's repo.
		if s.Mode != "local" {
			continue
		}
		// Step 4: validate Addr (Security §2). Reject and skip on failure.
		if _, _, err := validateAddr(s.Addr); err != nil {
			continue
		}
		// Step 5: containment match. Resolve the candidate's RepoDir; skip on
		// failure (deleted dir).
		resolvedRepo, err := filepath.EvalSymlinks(cleaned)
		if err != nil {
			continue
		}
		// Re-check resolved RepoDir != "/" — a symlink-to-root would slip past
		// the pre-filter (which sees the unresolved string).
		if filepath.Clean(resolvedRepo) == "/" {
			continue
		}
		if !containsPath(resolvedRepo, resolvedCwd) {
			continue
		}
		matches = append(matches, candidate{sess: s, resolved: resolvedRepo})
	}

	// Step 7: zero matches.
	if len(matches) == 0 {
		var b strings.Builder
		fmt.Fprintf(&b, "no running lightjj session matches %s", repoPath)
		if len(alive) > 0 {
			b.WriteString("\nrunning sessions:")
			for _, s := range alive {
				fmt.Fprintf(&b, "\n  pid %d  %s  %s  %s", s.PID, s.Addr, s.Mode, s.RepoDir)
			}
		}
		b.WriteString("\nuse --repo to match a different path, --addr to bypass discovery, or start lightjj in the repo")
		return sessionInfo{}, errors.New(b.String())
	}

	// Step 6: most-specific (deepest) RepoDir wins. Among matches all RepoDirs
	// are ancestors of repoPath and therefore prefixes of one another, so byte
	// length agrees with component depth on the winner.
	sort.SliceStable(matches, func(i, j int) bool {
		return len(matches[i].resolved) > len(matches[j].resolved)
	})
	best := matches[0]
	// Sorted longest-first: a tie can only be matches[1] sharing matches[0]'s
	// resolved RepoDir (two lightjj instances on the same repo). Don't
	// auto-pick — a stale instance could shadow a fresh one.
	if len(matches) > 1 && matches[1].resolved == best.resolved {
		var b strings.Builder
		fmt.Fprintf(&b, "multiple lightjj sessions match %s; use --addr to pick one:", best.resolved)
		for _, c := range matches {
			if c.resolved != best.resolved {
				break
			}
			fmt.Fprintf(&b, "\n  pid %d  %s  started %s", c.sess.PID, c.sess.Addr, time.UnixMilli(c.sess.StartedAt).Format(time.RFC3339))
		}
		return sessionInfo{}, errors.New(b.String())
	}
	return best.sess, nil
}

// doAPIRequest builds and sends an HTTP request to a validated loopback
// address. The URL is constructed via url.URL with net.JoinHostPort — never
// string concatenation — so a malformed addr can't smuggle in a different host
// via userinfo syntax. path may include `?query`; url.Parse extracts both
// parts. Sets Content-Type: application/json when a body is present unless
// overridden via -H.
func doAPIRequest(addr, method, path string, body io.Reader, extraHeaders []string) (*http.Response, error) {
	host, port, err := validateAddr(addr)
	if err != nil {
		return nil, err
	}
	pu, err := url.Parse(path)
	if err != nil {
		return nil, fmt.Errorf("invalid path %q: %v", path, err)
	}
	u := url.URL{
		Scheme:   "http",
		Host:     net.JoinHostPort(host, port),
		Path:     pu.Path,
		RawQuery: pu.RawQuery,
	}
	req, err := http.NewRequest(method, u.String(), body)
	if err != nil {
		return nil, err
	}
	hasContentType := false
	for _, h := range extraHeaders {
		k, v, ok := strings.Cut(h, ":")
		if !ok {
			return nil, fmt.Errorf("invalid header %q (want \"Key: Value\")", h)
		}
		k = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		if strings.EqualFold(k, "Content-Type") {
			hasContentType = true
		}
		// Add, not Set — repeated -H of the same key appends, matching curl.
		// Go's transport rejects \r/\n in header values at RoundTrip time, so
		// no manual injection check needed.
		req.Header.Add(k, v)
	}
	if body != nil && !hasContentType {
		req.Header.Set("Content-Type", "application/json")
	}
	client := &http.Client{Timeout: 30 * time.Second}
	return client.Do(req)
}

const apiUsage = `usage: lightjj api [flags] METHOD PATH [BODY]

  METHOD   GET | POST | PUT | DELETE | PATCH (case-insensitive, uppercased)
  PATH     verbatim URL path, including query string. Not auto-prefixed —
           tab-scoped routes are /tab/{N}/api/...
  BODY     literal JSON | @file (path relative to CWD) | "-" for stdin.

flags:
  --addr   host:port — bypass discovery entirely. Loopback only.
  --repo   path — match a different repo than cwd
  -H       "Key: Value" — extra header (repeatable)

flags must come before METHOD.
`

// runAPISubcommand implements `lightjj api`. Returns an exit code per the
// Output contract in api-cli.md: 0=2xx, 1=discovery/connection, 2=usage,
// 4=4xx, 5=5xx, else <400→0/≥400→1.
func runAPISubcommand(args []string) int {
	fs := flag.NewFlagSet("api", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	addrFlag := fs.String("addr", "", "host:port — bypass discovery (loopback only)")
	repoFlag := fs.String("repo", "", "match a different repo than cwd")
	var headers headerSlice
	fs.Var(&headers, "H", "extra header (repeatable)")
	fs.Usage = func() { fmt.Fprint(os.Stderr, apiUsage) }
	if err := fs.Parse(args); err != nil {
		return 2
	}

	pos := fs.Args()
	if len(pos) < 2 {
		fmt.Fprint(os.Stderr, apiUsage)
		return 2
	}
	if len(pos) > 3 {
		fmt.Fprintf(os.Stderr, "lightjj api: too many arguments (flags must come before METHOD)\n")
		return 2
	}
	method := strings.ToUpper(pos[0])
	path := pos[1]

	// Resolve the target address: explicit --addr bypasses discovery entirely.
	var addr string
	if *addrFlag != "" {
		if _, _, err := validateAddr(*addrFlag); err != nil {
			fmt.Fprintf(os.Stderr, "lightjj api: %v\n", err)
			return 2
		}
		addr = *addrFlag
	} else {
		dir, err := sessionDirReadOnly()
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				fmt.Fprintln(os.Stderr, "lightjj api: no running lightjj session found (session dir missing)")
			} else {
				fmt.Fprintf(os.Stderr, "lightjj api: %v\n", err)
			}
			return 1
		}
		repoPath := *repoFlag
		if repoPath == "" {
			repoPath, err = os.Getwd()
			if err != nil {
				fmt.Fprintf(os.Stderr, "lightjj api: cannot determine working directory: %v\n", err)
				return 1
			}
		}
		sess, err := discoverSession(dir, repoPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "lightjj api: %v\n", err)
			return 1
		}
		addr = sess.Addr
	}

	// Resolve the body source.
	var bodyReader io.Reader
	if len(pos) == 3 {
		raw := pos[2]
		switch {
		case raw == "-":
			bodyReader = os.Stdin
		case strings.HasPrefix(raw, "@"):
			f, err := os.Open(raw[1:])
			if err != nil {
				fmt.Fprintf(os.Stderr, "lightjj api: %v\n", err)
				return 2
			}
			defer f.Close()
			bodyReader = f
		default:
			bodyReader = strings.NewReader(raw)
		}
	}

	resp, err := doAPIRequest(addr, method, path, bodyReader, headers)
	if err != nil {
		fmt.Fprintf(os.Stderr, "lightjj api: %v\n", err)
		return 1
	}
	defer resp.Body.Close()
	// stdout: response body, always — even on 4xx/5xx (the API returns JSON
	// error objects that agents pipe to jq).
	_, _ = io.Copy(os.Stdout, resp.Body)
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return 0
	}
	fmt.Fprintf(os.Stderr, "HTTP %d %s\n", resp.StatusCode, http.StatusText(resp.StatusCode))
	switch {
	case resp.StatusCode >= 400 && resp.StatusCode < 500:
		return 4
	case resp.StatusCode >= 500 && resp.StatusCode < 600:
		return 5
	case resp.StatusCode < 400:
		return 0
	default:
		return 1
	}
}

// runSessionsSubcommand implements `lightjj sessions`. Lists ALL alive
// sessions including SSH-mode (which `lightjj api` discovery filters out).
// Sweeps stale entries first; the verifyOwnedDir hard-error in
// sessionDirReadOnly is what makes that os.Remove safe.
func runSessionsSubcommand(args []string) int {
	fs := flag.NewFlagSet("sessions", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	jsonOut := fs.Bool("json", false, "JSON output")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	dir, err := sessionDirReadOnly()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			// No session dir — no sessions. Exit 0 with empty output.
			if *jsonOut {
				fmt.Println("[]")
			}
			return 0
		}
		fmt.Fprintf(os.Stderr, "lightjj sessions: %v\n", err)
		return 1
	}
	sweepStaleSessions(dir)
	sessions, err := readSessions(dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "lightjj sessions: %v\n", err)
		return 1
	}
	live := []sessionInfo{}
	for _, s := range sessions {
		if pidAlive(s.PID) {
			live = append(live, s)
		}
	}
	sort.Slice(live, func(i, j int) bool { return live[i].PID < live[j].PID })

	if *jsonOut {
		b, _ := json.MarshalIndent(live, "", "  ")
		fmt.Println(string(b))
		return 0
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "PID\tADDR\tMODE\tREPO")
	for _, s := range live {
		fmt.Fprintf(w, "%d\t%s\t%s\t%s\n", s.PID, s.Addr, s.Mode, s.RepoDir)
	}
	w.Flush()
	return 0
}
