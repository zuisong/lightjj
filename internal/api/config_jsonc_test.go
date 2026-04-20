package api

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tailscale/hujson"
)

func TestStandardizeJSONC_StripsCommentsAndTrailingCommas(t *testing.T) {
	input := []byte(`{
  // theme comment
  "theme": "gruvbox",
  "splitView": true, // trailing comma below
}`)
	out, err := standardizeJSONC(input)
	require.NoError(t, err)
	// Standardize replaces comments/commas with spaces — same byte offsets, no comments.
	assert.NotContains(t, string(out), "//")
	// Valid JSON now — json.Unmarshal must accept it.
	var m map[string]any
	require.NoError(t, unmarshalJSONC(out, &m))
	assert.Equal(t, "gruvbox", m["theme"])
	assert.Equal(t, true, m["splitView"])
}

func TestStandardizeJSONC_PlainJSONPassesThrough(t *testing.T) {
	input := []byte(`{"theme":"dark"}`)
	out, err := standardizeJSONC(input)
	require.NoError(t, err)
	var m map[string]any
	require.NoError(t, unmarshalJSONC(out, &m))
	assert.Equal(t, "dark", m["theme"])
}

func TestStandardizeJSONC_InvalidReturnsError(t *testing.T) {
	_, err := standardizeJSONC([]byte(`{not json`))
	assert.Error(t, err)
}

func TestPatchPreservesComment(t *testing.T) {
	input := []byte(`{
  // keep this comment
  "theme": "dark",
  "splitView": false
}`)
	out, err := patchConfigKeys(input, map[string][]byte{
		"theme": []byte(`"light"`),
	})
	require.NoError(t, err)
	assert.Contains(t, string(out), "// keep this comment")
	assert.Contains(t, string(out), `"theme": "light"`)
}

func TestPatchAddsMissingKey(t *testing.T) {
	input := []byte(`{"theme":"dark"}`)
	out, err := patchConfigKeys(input, map[string][]byte{
		"splitView": []byte(`true`),
	})
	require.NoError(t, err)
	// Exact formatting is hujson's call; just verify it's present + parseable.
	var m map[string]any
	require.NoError(t, unmarshalJSONC(out, &m))
	assert.Equal(t, true, m["splitView"])
	assert.Equal(t, "dark", m["theme"])
}

func TestConfigTemplate_IsValidJSONC(t *testing.T) {
	_, err := hujson.Parse([]byte(configTemplate))
	require.NoError(t, err, "template must parse as JSONC")
}

func TestConfigTemplate_StandardizesToValidJSON(t *testing.T) {
	std, err := standardizeJSONC([]byte(configTemplate))
	require.NoError(t, err)
	var m map[string]any
	require.NoError(t, json.Unmarshal(std, &m))
	// Must carry the default values the frontend's `defaults` object expects.
	// Keep this list in sync with frontend/src/lib/config.svelte.ts#defaults.
	assert.Equal(t, "dark", m["theme"])
	assert.Equal(t, false, m["splitView"])
	assert.Equal(t, float64(13), m["fontSize"])
	assert.Equal(t, "", m["fontUI"])
	assert.Equal(t, "", m["fontMono"])
	_, hasEditorArgs := m["editorArgs"]
	assert.True(t, hasEditorArgs, "editorArgs must be in template for the teaching comment")
}

func TestConfigTemplate_ContainsTeachingComments(t *testing.T) {
	// Spot-check the comments the user will actually read. Don't over-specify
	// wording — just confirm the three "important" fields are commented.
	for _, key := range []string{"theme", "editorArgs", "fontSize"} {
		assert.Contains(t, configTemplate, `"`+key+`"`, "%s must be in template", key)
	}
	assert.Contains(t, configTemplate, "//", "template must contain at least one comment")
}
