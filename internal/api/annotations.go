package api

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

// annMu serializes read-modify-write across POST/DELETE handlers. Without it,
// two concurrent writes (cross-tab, same changeId) both read [a,b], one appends
// c, the other appends d; whichever renames last wins, the other is lost.
// atomicWriteJSON prevents torn writes but not lost updates. Global (not
// per-changeId) is fine — contention is rare, handlers are fast.
var annMu sync.Mutex

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

// mergeAnnotation upserts ann into items, preserving an existing record's
// status/resolution/resolvedAtCommitId when ann omits them, and its createdAt
// when ann's was server-stamped. Mirrors mergeDocComment — the agent_api.md
// "Review loop" tells agents to re-POST with the same id to amend a comment
// and to poll resolution for the human's accept/reject; without this merge a
// re-POST that omits the resolution fields (which the agent has no reason to
// echo back) would silently wipe the human's decision. Returns the post-merge
// ann so the HTTP response reflects what was actually stored.
func mergeAnnotation(items []Annotation, ann Annotation, stamped bool) ([]Annotation, Annotation) {
	for i := range items {
		if items[i].ID == ann.ID {
			if ann.Resolution == "" {
				ann.Resolution = items[i].Resolution
				ann.ResolvedAtCommitId = items[i].ResolvedAtCommitId
			}
			// Status is a coarser legacy flag that tracks Resolution (the
			// frontend's resolveAs writes both). Preserve it under the same
			// condition so the pair stays consistent — preserving one without
			// the other would render an "open" card with a wontfix tag.
			if ann.Status == "" {
				ann.Status = items[i].Status
			}
			if stamped {
				ann.CreatedAt = items[i].CreatedAt
			}
			break
		}
	}
	return upsertByID(items, ann), ann
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

func readAnnotations(changeId string) ([]Annotation, error) {
	path, err := annotationsPath(changeId)
	if err != nil {
		return nil, err
	}
	return readJSONStore[Annotation](path)
}

// GET /api/annotations?changeId=X
func (s *Server) handleAnnotationsGet(w http.ResponseWriter, r *http.Request) {
	changeId := r.URL.Query().Get("changeId")
	if changeId == "" {
		s.writeError(w, http.StatusBadRequest, "changeId required")
		return
	}
	anns, err := readAnnotations(changeId)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
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

	// Server-stamp createdAt when omitted, matching doc_comments.go. The
	// frontend store always sends one, but the agent_api.md POST example is
	// the first producer that doesn't — without this stamp, agent annotations
	// render as "56y" in CommentCard's relativeTime (epoch 0 falls through its
	// nullish guard).
	stamped := false
	if ann.CreatedAt == 0 {
		ann.CreatedAt = time.Now().UnixMilli()
		stamped = true
	}

	annMu.Lock()
	defer annMu.Unlock()

	anns, err := readAnnotations(ann.ChangeId)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	anns, ann = mergeAnnotation(anns, ann, stamped)

	path, _ := annotationsPath(ann.ChangeId) // validated via readAnnotations
	if err := atomicWriteJSON(path, anns); err != nil {
		s.writeError(w, http.StatusInternalServerError, "write failed: "+err.Error())
		return
	}
	s.writeJSON(w, r, http.StatusOK, ann)
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
	path, err := annotationsPath(changeId)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	annMu.Lock()
	defer annMu.Unlock()

	if id == "" {
		// Clear all — best-effort; missing file is success.
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			s.writeError(w, http.StatusInternalServerError, "remove failed")
			return
		}
		w.WriteHeader(http.StatusOK)
		return
	}

	anns, err := readAnnotations(changeId)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	out := removeByID(anns, id)
	if len(out) == 0 {
		// Last one deleted — remove the file rather than keep an empty array.
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			s.writeError(w, http.StatusInternalServerError, "remove failed")
			return
		}
	} else if err := atomicWriteJSON(path, out); err != nil {
		s.writeError(w, http.StatusInternalServerError, "write failed")
		return
	}
	w.WriteHeader(http.StatusOK)
}
