package jj

import (
	"encoding/json"
	"strings"
)

// Alias represents a user-defined jj alias from the [aliases] config section.
type Alias struct {
	Name    string   `json:"name"`
	Command []string `json:"command"` // e.g. ["git", "fetch", "-b", "glob:alice/*"]
}

// ParseAliases parses the output of `jj config list aliases` into a slice of Alias.
// Each entry starts with "aliases.<name> = " followed by a TOML-style array value
// that may span multiple lines.
func ParseAliases(output string) []Alias {
	if strings.TrimSpace(output) == "" {
		return []Alias{}
	}

	lines := strings.Split(output, "\n")
	aliases := []Alias{}
	var currentName string
	var currentValue strings.Builder

	flush := func() {
		if currentName == "" {
			return
		}
		raw := currentValue.String()
		cmd := parseAliasValue(raw)
		if len(cmd) > 0 {
			aliases = append(aliases, Alias{Name: currentName, Command: cmd})
		}
		currentName = ""
		currentValue.Reset()
	}

	for _, line := range lines {
		if strings.HasPrefix(line, "aliases.") {
			flush()
			// Split on first " = " to separate name from value
			before, after, ok := strings.Cut(line, " = ")
			if !ok {
				continue
			}
			currentName = strings.TrimPrefix(before, "aliases.")
			currentValue.WriteString(after)
		} else if currentName != "" {
			// Continuation line for multi-line array or triple-quoted string.
			// Preserve the newline — it's content inside triple-quoted strings.
			currentValue.WriteByte('\n')
			currentValue.WriteString(line)
		}
	}
	flush()

	return aliases
}

// parseAliasValue converts a TOML-style array string like ['git', 'fetch']
// into a Go string slice. Handles single quotes, double quotes, and TOML
// triple-quoted strings (''' and """) which appear in multi-line aliases
// (e.g. util exec bash scripts).
func parseAliasValue(raw string) []string {
	raw = strings.TrimSpace(raw)
	if len(raw) < 2 || raw[0] != '[' || raw[len(raw)-1] != ']' {
		return nil
	}

	// Normalize to JSON array. Walk character by character, handling four
	// TOML string types: basic (""), literal (''), multi-line basic ("""),
	// and multi-line literal ('''). Triple-quote forms must be checked
	// before single-quote forms (''' starts with ').
	var buf strings.Builder
	buf.Grow(len(raw))
	i := 0
	for i < len(raw) {
		// Check for triple-quoted strings first (''' or """)
		if i+2 < len(raw) {
			triple := raw[i : i+3]
			if triple == "'''" || triple == `"""` {
				delim := triple
				// Find matching closing triple-quote
				end := strings.Index(raw[i+3:], delim)
				if end < 0 {
					// Unclosed triple-quote — bail
					return nil
				}
				content := raw[i+3 : i+3+end]
				// TOML: first newline after opening ''' is stripped
				content = strings.TrimPrefix(content, "\n")
				// Emit as a JSON double-quoted string: escape backslashes,
				// double quotes, and newlines.
				buf.WriteByte('"')
				for _, c := range content {
					switch c {
					case '\\':
						buf.WriteString(`\\`)
					case '"':
						buf.WriteString(`\"`)
					case '\n':
						buf.WriteString(`\n`)
					case '\r':
						buf.WriteString(`\r`)
					case '\t':
						buf.WriteString(`\t`)
					default:
						buf.WriteRune(c)
					}
				}
				buf.WriteByte('"')
				i += 3 + end + 3 // skip content + closing delimiter
				continue
			}
		}

		ch := raw[i]
		switch {
		case ch == '\'':
			// Single-quoted TOML string → emit as double-quoted JSON string.
			// Find closing single quote.
			end := strings.IndexByte(raw[i+1:], '\'')
			if end < 0 {
				return nil
			}
			content := raw[i+1 : i+1+end]
			buf.WriteByte('"')
			for _, c := range content {
				switch c {
				case '\\':
					buf.WriteString(`\\`)
				case '"':
					buf.WriteString(`\"`)
				default:
					buf.WriteRune(c)
				}
			}
			buf.WriteByte('"')
			i += 1 + end + 1
		case ch == '"':
			// Double-quoted TOML string — pass through (already JSON-compatible).
			buf.WriteByte('"')
			i++
			for i < len(raw) && raw[i] != '"' {
				if raw[i] == '\\' && i+1 < len(raw) {
					buf.WriteByte(raw[i])
					buf.WriteByte(raw[i+1])
					i += 2
				} else {
					buf.WriteByte(raw[i])
					i++
				}
			}
			if i < len(raw) {
				buf.WriteByte('"')
				i++
			}
		default:
			buf.WriteByte(ch)
			i++
		}
	}

	normalized := buf.String()
	// Strip trailing commas before ] (TOML allows them, JSON doesn't)
	inner := strings.TrimRight(normalized[1:len(normalized)-1], ", \t\n\r")
	normalized = "[" + inner + "]"

	var result []string
	if err := json.Unmarshal([]byte(normalized), &result); err != nil {
		return nil
	}
	return result
}
