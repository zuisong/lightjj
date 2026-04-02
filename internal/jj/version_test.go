package jj

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestParseSemver(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want Semver
		ok   bool
	}{
		{"jj 0.39.0", Semver{0, 39}, true},
		{"jj 0.40.0-nightly+abc123", Semver{0, 40}, true},
		{"jj 1.2", Semver{1, 2}, true},
		{"jj-dev", Semver{}, false},
		{"", Semver{}, false},
	} {
		got, ok := ParseSemver(tc.in)
		assert.Equal(t, tc.ok, ok, tc.in)
		if ok {
			assert.Equal(t, tc.want, got, tc.in)
		}
	}
}

func TestSemverAtLeast(t *testing.T) {
	assert.True(t, Semver{0, 40}.AtLeast(Semver{0, 40}))
	assert.True(t, Semver{0, 41}.AtLeast(Semver{0, 40}))
	assert.True(t, Semver{1, 0}.AtLeast(Semver{0, 99}))
	assert.False(t, Semver{0, 39}.AtLeast(Semver{0, 40}))
	assert.False(t, Semver{0, 39}.AtLeast(Semver{1, 0}))
}
