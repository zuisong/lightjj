# lightjj agent API — doc-mode comments & suggestions

lightjj's doc mode lets a human review markdown files with range-anchored
comments and accept/reject text suggestions. Agents interact with the same
comment store via plain HTTP — no ProseMirror, no special client.

This doc is also served at `GET /api/agent` so a remote agent can fetch it
without repo access.

## Reaching the server

If you fetched this via `GET /api/agent`, the base URL is whatever you used —
substitute it for `<base>` below. The doc-mode UI's **Agent…** button copies
the exact `<base>` for the open file (correct host, port, and tab) to the
clipboard, so the user can paste it into your prompt.

lightjj binds to whatever `--addr` was given (default a localhost port; not
necessarily 3000). For an agent on another host:

- **SSH tunnel:** `ssh -L 8080:localhost:<lightjj-port> user@host` then use
  `<base> = http://localhost:8080/tab/0`.
- **Tailscale:** `tailscale serve <lightjj-port>`.
- **Explicit bind:** `lightjj --addr 0.0.0.0:<port>` — only behind a trusted
  network. The API includes `POST /api/file/write`; anything that can reach
  the port can write to the working copy.

All routes are tab-scoped: `<base> = <origin>/tab/{N}`. Tab 0 is the repo
lightjj was launched in; `GET <origin>/tabs` lists open tabs with their paths.

## Read the document

```
GET <base>/api/file/show?revision=@&path=docs/DESIGN.md
→ {"content": "# Design\n\n..."}
```

## Anchor model

Comments and suggestions are anchored by **content**, not line numbers or
byte offsets. Compute from the document text:

```json
{
  "selection": "the exact phrase you're commenting on",
  "contextBefore": "~40 chars immediately before it",
  "contextAfter": "~40 chars immediately after it"
}
```

On display, lightjj re-finds the anchor in the current document. If
`selection` is unique it lands exactly; if it appears multiple times the
context disambiguates; if the text was edited away the comment is shown as
"orphaned" with the original selection quoted.

## Post a comment

```
POST <base>/api/doc-comments
Content-Type: application/json

{
  "id": "<uuid>",
  "filePath": "docs/DESIGN.md",
  "anchor": { "selection": "...", "contextBefore": "...", "contextAfter": "..." },
  "kind": "comment",
  "body": "markdown body — rendered in the rail",
  "author": "agent-name",
  "createdAt": 1746543600000
}
```

## Post a suggestion

Same endpoint, `kind: "suggestion"` plus a `suggestion.replacement`:

```json
{
  "id": "<uuid>",
  "filePath": "docs/DESIGN.md",
  "anchor": { "selection": "single-binary", "contextBefore": "powerful, ", "contextAfter": " Jujutsu" },
  "kind": "suggestion",
  "suggestion": { "replacement": "single binary" },
  "body": "prefer hyphenless per style guide",
  "author": "agent-name",
  "createdAt": 1746543600000
}
```

The user sees the selection struck through with the replacement below it and
**Accept** / **Reject** buttons. Accept replaces the text in the live editor;
Reject marks `resolution: "wontfix"`.

## Read back / poll

```
GET <base>/api/doc-comments?path=docs/DESIGN.md
→ [{"id": "...", "resolution": "addressed", ...}, ...]
```

`resolution` is `"addressed"` (accepted/resolved), `"wontfix"` (rejected), or
absent (open).

## Delete

```
DELETE <base>/api/doc-comments?path=docs/DESIGN.md&id=<uuid>
```

Cascade-deletes any replies (`parentId == id`).

## Threading

Replies set `parentId` to the root comment's `id`. The `anchor` on a reply
should match the root's (it's used for re-find but only the root is rendered
as a highlight).
