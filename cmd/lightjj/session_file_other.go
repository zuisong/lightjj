//go:build !unix

package main

import "os"

// No uid concept on Windows; the perm check in verifyOwnedDir is the only gate.
func verifyOwner(string, os.FileInfo) error { return nil }
