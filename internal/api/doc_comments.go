package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// doc_comments.go — range-anchored, per-filePath document comments for the
// ProseMirror doc mode. Unlike annotations (per-changeId, line-anchored,
// review-of-a-diff), these are per-file and survive across commits — closer to
// a Google Docs comment than a code-review note.
//
// Storage: $XDG_CONFIG_HOME/lightjj/doc-comments/{hash}.json where
// hash = sha256(RepoPath + "|" + filePath)[:16]. Hashing the key sidesteps
// path-traversal validation and filesystem-unsafe characters in filePath.
// RepoPath (not RepoDir) is set in both local and SSH mode.

type DocAnchor struct {
	Selection     string `json:"selection"`
	ContextBefore string `json:"contextBefore"`
	ContextAfter  string `json:"contextAfter"`
}

type DocSuggestion struct {
	Replacement string `json:"replacement"`
	BaseVersion int    `json:"baseVersion"`
}

type DocComment struct {
	ID         string         `json:"id"`
	FilePath   string         `json:"filePath"`
	ParentId   string         `json:"parentId,omitempty"`
	Anchor     DocAnchor      `json:"anchor"`
	Kind       string         `json:"kind"` // comment | suggestion
	Body       string         `json:"body"`
	Suggestion *DocSuggestion `json:"suggestion,omitempty"`
	Resolution string         `json:"resolution,omitempty"` // addressed | wontfix
	ResolvedAt int64          `json:"resolvedAt,omitempty"`
	Author     string         `json:"author"`
	CreatedAt  int64          `json:"createdAt"`
}

func (c DocComment) GetID() string { return c.ID }

// docCommentStore is the per-(repo, filePath) doc-comment collection. The
// store key is the full hash input — RepoPath + "|" + cleaned filePath (see
// docCommentKey) — so this package-level store works across Server instances
// (tabs) while each repo+file pair maps to its own file. Package-level for the
// same reason as annotationStore: the mutex must be shared across tabs.
var docCommentStore = &jsonCollection[DocComment]{
	pathFor: docCommentStorePath,
	merge:   mergeDocComment,
	stamp:   stampDocComment,
	// Cascade-delete replies: a thread root delete must take its children
	// or they reload as ghost highlights with no rail card and no UI delete.
	deleteMatch: func(c DocComment, id string) bool {
		return c.ID == id || c.ParentId == id
	},
}

// docCommentKey builds the store key for an already-cleaned filePath. The key
// (not the raw filePath) determines the on-disk filename: sha256(key)[:16].
func (s *Server) docCommentKey(cleanPath string) string {
	return s.RepoPath + "|" + cleanPath
}

func docCommentStorePath(key string) (string, error) {
	dir, err := userConfigDir()
	if err != nil {
		return "", err
	}
	h := sha256.Sum256([]byte(key))
	return filepath.Join(dir, "lightjj", "doc-comments", hex.EncodeToString(h[:])[:16]+".json"), nil
}

// cleanDocPath normalizes filePath to a canonical repo-relative form so that
// "./docs/X.md" and "docs/X.md" hash to the same store. Agents POST against
// paths they read from /api/file-show; the UI uses paths from the diff parser —
// without normalization those silently diverge. Rejects absolute paths and
// ..-escapes (the hash already prevents traversal on disk, but a rejected error
// is clearer to the agent than a silently empty store).
func cleanDocPath(p string) (string, error) {
	c := filepath.ToSlash(filepath.Clean(p))
	c = strings.TrimPrefix(c, "./")
	if c == ".." || strings.HasPrefix(c, "../") || strings.HasPrefix(c, "/") {
		return "", errors.New("path escapes repo")
	}
	return c, nil
}

// mergeDocComment preserves an existing record's resolution/resolvedAt/
// createdAt when the incoming upsert omits them — so an agent re-POST to amend
// a body doesn't clobber the human's accept/reject or rewrite history.
func mergeDocComment(existing, incoming DocComment) DocComment {
	if incoming.Resolution == "" {
		incoming.Resolution = existing.Resolution
		incoming.ResolvedAt = existing.ResolvedAt
	}
	if incoming.CreatedAt == 0 {
		incoming.CreatedAt = existing.CreatedAt
	}
	return incoming
}

// stampDocComment fills server-side defaults: a random id when the client
// omitted one, and createdAt when neither the client nor an existing merged
// record supplied it.
func stampDocComment(c *DocComment) {
	if c.ID == "" {
		c.ID = randID()
	}
	if c.CreatedAt == 0 {
		c.CreatedAt = time.Now().UnixMilli()
	}
}

func randID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// GET /api/doc-comments?path=X — list (empty array if none).
func (s *Server) handleDocCommentsGet(w http.ResponseWriter, r *http.Request) {
	fp := r.URL.Query().Get("path")
	if fp == "" {
		s.writeError(w, http.StatusBadRequest, "path required")
		return
	}
	clean, err := cleanDocPath(fp)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	items, err := docCommentStore.List(s.docCommentKey(clean))
	if err != nil {
		s.writeError(w, storeErrStatus(err), err.Error())
		return
	}
	s.writeJSON(w, r, http.StatusOK, items)
}

// POST /api/doc-comments — upsert by id (body = DocComment).
func (s *Server) handleDocCommentsPost(w http.ResponseWriter, r *http.Request) {
	var c DocComment
	if err := decodeBody(w, r, &c); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if c.FilePath == "" {
		s.writeError(w, http.StatusBadRequest, "filePath required")
		return
	}
	if c.Anchor.Selection == "" {
		s.writeError(w, http.StatusBadRequest, "anchor.selection required")
		return
	}
	clean, err := cleanDocPath(c.FilePath)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	c.FilePath = clean
	stored, err := docCommentStore.Upsert(s.docCommentKey(clean), c)
	if err != nil {
		s.writeError(w, storeErrStatus(err), err.Error())
		return
	}
	s.writeJSON(w, r, http.StatusOK, stored)
}

// DELETE /api/doc-comments?path=X&id=Y — remove one (cascades to replies).
// Unlike annotations, id is required: there is no clear-all.
func (s *Server) handleDocCommentsDelete(w http.ResponseWriter, r *http.Request) {
	fp := r.URL.Query().Get("path")
	id := r.URL.Query().Get("id")
	if fp == "" {
		s.writeError(w, http.StatusBadRequest, "path required")
		return
	}
	clean, err := cleanDocPath(fp)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if id == "" {
		s.writeError(w, http.StatusBadRequest, "id required")
		return
	}
	if err := docCommentStore.Delete(s.docCommentKey(clean), id); err != nil {
		s.writeError(w, storeErrStatus(err), err.Error())
		return
	}
	w.WriteHeader(http.StatusOK)
}

const maxBatchComments = 256

type docCommentBatchRequest struct {
	FilePath string       `json:"filePath"`
	Comments []DocComment `json:"comments"`
}

// POST /api/doc-comments/batch — handleDocCommentsBatch validates ALL comments
// before writing ANY: an agent posting 12 review notes gets all-or-nothing
// instead of a partial set on the 7th failing validation. UpsertBatch holds
// the store mutex for the whole batch so a concurrent single-POST can't
// interleave between the read and the write.
func (s *Server) handleDocCommentsBatch(w http.ResponseWriter, r *http.Request) {
	var req docCommentBatchRequest
	if err := decodeBody(w, r, &req); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.FilePath == "" {
		s.writeError(w, http.StatusBadRequest, "filePath required")
		return
	}
	if n := len(req.Comments); n == 0 || n > maxBatchComments {
		s.writeError(w, http.StatusBadRequest,
			fmt.Sprintf("comments must have 1..%d entries (got %d)", maxBatchComments, n))
		return
	}
	clean, err := cleanDocPath(req.FilePath)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	for i := range req.Comments {
		if req.Comments[i].Anchor.Selection == "" {
			s.writeError(w, http.StatusBadRequest, "comments["+strconv.Itoa(i)+"].anchor.selection required")
			return
		}
		req.Comments[i].FilePath = clean
	}
	stored, err := docCommentStore.UpsertBatch(s.docCommentKey(clean), req.Comments)
	if err != nil {
		s.writeError(w, storeErrStatus(err), err.Error())
		return
	}
	s.writeJSON(w, r, http.StatusOK, stored)
}
