---
name: lightjj
description: Interacts with a running lightjj instance (browser-based Jujutsu/jj viewer) via the `lightjj api` CLI. Reads diffs, posts inline review comments, posts doc-mode suggestions, and steers the user's view. Use when the user has lightjj running and wants the agent to review changes, annotate diffs, or comment on markdown docs.
---

# lightjj

lightjj is a browser-based UI for [Jujutsu](https://github.com/jj-vcs/jj) (jj)
version control. The browser is for the user — do NOT open URLs or screenshot
it. Use `lightjj api` to read and write through the same HTTP API the browser
uses. It auto-discovers the running instance, sets headers correctly, and works
in harnesses that denylist `curl`.

If no lightjj is running, ask the user to start it (`lightjj` in a jj repo) —
do not start it yourself.

## Bootstrap

```text
1. lightjj sessions                          # confirm a session exists, find its repo
2. lightjj api GET /tab/0/api/agent          # full API contract (markdown) — read once
3. lightjj api GET /tab/0/api/capabilities   # probe feature availability
```

`GET /api/agent` is the source of truth for endpoints, request/response schemas,
and the comment/suggestion model. Read it before guessing routes — it's ~200
lines and describes the doc-comment store, the navigate endpoint, and the
review-comment store.

## Synopsis

```text
lightjj api [flags] METHOD PATH [BODY]

  METHOD   GET | POST | PUT | DELETE | PATCH
  PATH     verbatim — most routes are tab-scoped: /tab/{N}/api/...
           Root-only: /tabs, /api/config. Tab 0 is the launch repo.
  BODY     literal JSON | @file | "-" for stdin

flags:
  --addr   host:port — bypass discovery (multiple sessions, SSH tunnel). Loopback only.
  --repo   path — match a different repo than cwd
  -H       "Key: Value" — extra header (repeatable)

exit codes: 0 = 2xx, 1 = connection/discovery, 2 = usage, 4 = HTTP 4xx, 5 = HTTP 5xx
```

Quote query strings — bare `&` backgrounds the shell:

```bash
lightjj api GET '/tab/0/api/file-show?revision=@&path=docs/DESIGN.md'
```

## Common operations

```bash
# Read the current revision graph (commit metadata, descriptions, bookmarks)
lightjj api GET /tab/0/api/log

# Read a file at a revision
lightjj api GET '/tab/0/api/file-show?revision=@&path=src/main.go'

# Read existing doc-mode comments on a markdown file
lightjj api GET '/tab/0/api/doc-comments?path=docs/DESIGN.md'

# Post a doc-mode comment (range-anchored on rendered text — see /api/agent
# for the anchor schema)
lightjj api POST /tab/0/api/doc-comments @comment.json

# Steer the user's view to a file/line
lightjj api POST /tab/0/api/navigate '{"path":"src/main.go","line":42}'

# Read inline review comments (annotations) on a change
lightjj api GET '/tab/0/api/annotations?change_id=xyzabc'
```

## Multiple sessions / repos

Discovery matches the agent's cwd against each session's repo dir. If you're
inside the same repo lightjj was launched in, `lightjj api ...` just works. If
not:

```bash
lightjj sessions                              # see what's running
lightjj api --repo /path/to/other GET /tab/0/api/log
lightjj api --addr 127.0.0.1:54321 GET /tab/0/api/log
```

A session run with `lightjj --remote user@host:/repo` is listed by `sessions`
but won't auto-match — its repo dir is a remote path. Use `--addr`.

## Don't

- Don't `curl` — the entire reason `lightjj api` exists is that harnesses
  deny `curl`. It also won't auto-discover the port or set `Content-Type`.
- Don't run `jj` commands directly when the user is reviewing in lightjj —
  the snapshot loop will pick up your changes and the user's view will jump.
  If you need to mutate, tell the user what you'd do and let them decide.
- Don't open the browser URL or screenshot the UI.
- Don't guess endpoint shapes — `lightjj api GET /tab/0/api/agent` documents
  all of them with example payloads.

## Common errors

- **`no running lightjj session matches <path>`** — lightjj isn't running in
  this repo. Ask the user to start it, or pass `--repo`/`--addr`.
- **`address ... is not loopback`** — `--addr` only accepts `127.0.0.1`,
  `::1`, or `localhost`. SSH tunnels: forward to a local port, then `--addr 127.0.0.1:N`.
- **`multiple lightjj sessions match`** — two instances on the same repo.
  `lightjj sessions`, then pick one with `--addr`.
- **HTTP 200 but the body is HTML** — you forgot the `/tab/N/` prefix; the
  unprefixed path falls through to the SPA. Use `/tab/0/api/...`.
- **HTTP 400 `Content-Type must be application/json`** — only happens with
  `curl`; `lightjj api` sets it automatically when a body is present.
