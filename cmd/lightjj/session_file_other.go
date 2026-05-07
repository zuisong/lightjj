//go:build !unix

package main

import "os"

// Stub for !unix builds. writeSessionFile short-circuits on Windows so this
// is never reached there; kept so the package compiles for plan9/js/wasip1.
func verifyOwner(string, os.FileInfo) error { return nil }
