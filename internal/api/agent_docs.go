package api

import (
	_ "embed"
	"net/http"
)

// Served at GET /api/agent so an agent (local or via port-forward) can
// discover the doc-comments interface without repo file access. The markdown
// lives next to this file so go:embed can reach it; it's the single source.
//
//go:embed agent_api.md
var agentAPIDoc []byte

func (s *Server) handleAgentDocs(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Write(agentAPIDoc)
}
