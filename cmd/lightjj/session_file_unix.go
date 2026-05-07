//go:build unix

package main

import (
	"fmt"
	"os"
	"syscall"
)

func verifyOwner(path string, fi os.FileInfo) error {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return nil
	}
	if int(st.Uid) != os.Getuid() {
		return fmt.Errorf("session dir %s not owned by current user", path)
	}
	return nil
}
