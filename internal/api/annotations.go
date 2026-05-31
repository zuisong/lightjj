package api

import (
	"errors"
	"net/http"
	"path/filepath"
	"regexp"
	"time"
)

// Annotations are per-change_id review comments for agent-iteration workflows.
// Stored at $XDG_CONFIG_HOME/lightjj/annotations/{changeId}.json so spawned
// workspace instances on different ports share one store — localStorage would
// isolate by origin.
//
// The backend is a dumb CRUD store. Re-anchoring (line number drift across
// agent iterations) is computed client-side via /api/diff-range — the server
// doesn't know which commit_id is "current", and re-anchor math belongs with
// the diff parser that's already in the frontend.

// Annotation mirrors the frontend type. The server validates only ChangeId
// (routing) and ID (upsert/delete). Note: this is a typed struct, not a
// json.RawMessage — fields the frontend adds must be mirrored here or they're
// dropped on the unmarshal→marshal round-trip.
type Annotation struct {
	ID                string `json:"id"`
	ChangeId          string `json:"changeId"`
	FilePath          string `json:"filePath"`
	LineNum           int    `json:"lineNum"`
	Side              string `json:"side,omitempty"`
	LineContent       string `json:"lineContent"`
	Comment           string `json:"comment"`
	Severity          string `json:"severity,omitempty"`
	CreatedAt         int64  `json:"createdAt"`
	CreatedAtCommitId string `json:"createdAtCommitId"`
	Status            string `json:"status,omitempty"`
	// Resolution distinguishes addressed-vs-wontfix; Status:'resolved' alone
	// can't. fromAnnotation prefers this over Status when present.
	Resolution         string `json:"resolution,omitempty"`
	ResolvedAtCommitId string `json:"resolvedAtCommitId,omitempty"`
	// Author distinguishes agent-posted from user-posted comments. Absent =
	// "you" (the user). Agents should set a stable name so the frontend can
	// render the ⟐ prefix and offer "Hide author". Mirrors DocComment.Author —
	// without this the field was silently DROPPED on the unmarshal→marshal
	// round-trip (typed struct, not RawMessage; see comment on the type).
	Author string `json:"author,omitempty"`
}

func (a Annotation) GetID() string { return a.ID }

// annotationStore is the per-changeId annotation collection. Package-level
// (not a Server field) because annotation files are keyed by changeId alone —
// two tabs (separate Server instances) can address the same file, so the
// store's mutex must be shared across all of them.
var annotationStore = &jsonCollection[Annotation]{
	pathFor: annotationsPath,
	merge:   mergeAnnotation,
	stamp:   stampAnnotation,
}

// mergeAnnotation preserves an existing record's status/resolution/
// resolvedAtCommitId/createdAt when the incoming upsert omits them. The
// agent_api.md "Review loop" tells agents to re-POST with the same id to amend
// a comment and to poll resolution for the human's accept/reject; without this
// merge a re-POST that omits the resolution fields (which the agent has no
// reason to echo back) would silently wipe the human's decision.
func mergeAnnotation(existing, incoming Annotation) Annotation {
	if incoming.Resolution == "" {
		incoming.Resolution = existing.Resolution
		incoming.ResolvedAtCommitId = existing.ResolvedAtCommitId
	}
	// Status is a coarser legacy flag that tracks Resolution (the frontend's
	// resolveAs writes both). Preserve it under the same condition so the pair
	// stays consistent — preserving one without the other would render an
	// "open" card with a wontfix tag.
	if incoming.Status == "" {
		incoming.Status = existing.Status
	}
	if incoming.CreatedAt == 0 {
		incoming.CreatedAt = existing.CreatedAt
	}
	return incoming
}

// stampAnnotation server-stamps createdAt when the client omitted it (and no
// existing record carried one through the merge). The frontend store always
// sends one, but the agent_api.md POST example is the first producer that
// doesn't — without this stamp, agent annotations render as "56y" in
// CommentCard's relativeTime (epoch 0 falls through its nullish guard).
func stampAnnotation(a *Annotation) {
	if a.CreatedAt == 0 {
		a.CreatedAt = time.Now().UnixMilli()
	}
}

// changeId is embedded in a filesystem path — restrict to jj's charset
// (lowercase alphanum for change_ids, hex for commit_ids if used as fallback).
// This prevents path traversal (../, null bytes) and keeps filenames portable.
var changeIdRe = regexp.MustCompile(`^[a-z0-9]{1,64}$`)

func annotationsPath(changeId string) (string, error) {
	if !changeIdRe.MatchString(changeId) {
		return "", errors.New("invalid changeId")
	}
	dir, err := userConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "lightjj", "annotations", changeId+".json"), nil
}

// GET /api/annotations?changeId=X
func (s *Server) handleAnnotationsGet(w http.ResponseWriter, r *http.Request) {
	changeId := r.URL.Query().Get("changeId")
	if changeId == "" {
		s.writeError(w, http.StatusBadRequest, "changeId required")
		return
	}
	anns, err := annotationStore.List(changeId)
	if err != nil {
		s.writeError(w, storeErrStatus(err), err.Error())
		return
	}
	s.writeJSON(w, r, http.StatusOK, anns)
}

// POST /api/annotations — upsert. Body is a single Annotation. Matched by ID
// within the file for its ChangeId; appended if not found.
func (s *Server) handleAnnotationsPost(w http.ResponseWriter, r *http.Request) {
	var ann Annotation
	if err := decodeBody(w, r, &ann); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if ann.ChangeId == "" || ann.ID == "" {
		s.writeError(w, http.StatusBadRequest, "changeId and id required")
		return
	}
	stored, err := annotationStore.Upsert(ann.ChangeId, ann)
	if err != nil {
		s.writeError(w, storeErrStatus(err), err.Error())
		return
	}
	s.writeJSON(w, r, http.StatusOK, stored)
}

// DELETE /api/annotations?changeId=X&id=Y — remove by ID. If id is omitted,
// the entire file is deleted (clear all for this change).
func (s *Server) handleAnnotationsDelete(w http.ResponseWriter, r *http.Request) {
	changeId := r.URL.Query().Get("changeId")
	id := r.URL.Query().Get("id")
	if changeId == "" {
		s.writeError(w, http.StatusBadRequest, "changeId required")
		return
	}
	var err error
	if id == "" {
		err = annotationStore.DeleteAll(changeId)
	} else {
		err = annotationStore.Delete(changeId, id)
	}
	if err != nil {
		s.writeError(w, storeErrStatus(err), err.Error())
		return
	}
	w.WriteHeader(http.StatusOK)
}
