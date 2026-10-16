//go:build linux

package main

import (
	"fmt"
	"os"
	"syscall"
)

func main() {
	for _, family := range []int{syscall.AF_INET, syscall.AF_INET6, syscall.AF_UNIX} {
		for _, kind := range []int{syscall.SOCK_STREAM, syscall.SOCK_DGRAM} {
			fd, err := syscall.Socket(family, kind, 0)
			if err == nil {
				syscall.Close(fd)
			}
			if err != syscall.EPERM {
				panic("socket creation was not denied by policy")
			}
		}
	}
	if _, err := syscall.Setsid(); err != syscall.EPERM {
		panic("session escape was not denied")
	}
	if err := os.WriteFile("/other/escape", []byte("denied"), 0600); !os.IsPermission(err) {
		panic("outside writable mount was not denied")
	}
	if _, err := os.ReadFile("/etc/passwd"); !os.IsPermission(err) {
		panic("outside readable file was not denied")
	}
	if err := os.Symlink("/etc/passwd", "escape-link"); err != nil {
		panic("workspace symlink creation failed")
	}
	if _, err := os.ReadFile("escape-link"); !os.IsPermission(err) {
		panic("symlink escape was not denied")
	}
	if err := os.WriteFile("allowed.txt", []byte("allowed"), 0600); err != nil {
		panic("workspace write failed")
	}
	fmt.Println("OFFLINE_SANDBOX_PROBE_PASS")
}
