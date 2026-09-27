//go:build linux

// This disposable capability probe is not an execution sandbox.
package main

import (
	"fmt"
	"os"
	"runtime"
	"syscall"
	"unsafe"
)

func main() {
	if runtime.GOARCH != "arm64" && runtime.GOARCH != "amd64" {
		fmt.Println("unsupported probe architecture")
		os.Exit(2)
	}
	runtime.LockOSThread()
	abi, _, errno := syscall.RawSyscall(444, 0, 0, 1)
	if errno != 0 {
		fmt.Printf("landlock ABI unavailable: %s\n", errno)
		os.Exit(1)
	}
	fmt.Printf("landlock ABI: %d\n", abi)
	if len(os.Args) != 2 {
		os.Exit(2)
	}
	filename := os.Args[1]
	fd, err := syscall.Open(filename, syscall.O_RDONLY, 0)
	if err != nil {
		fmt.Println("baseline read failed")
		os.Exit(1)
	}
	syscall.Close(fd)
	// Handle read-file with no allow rules: subsequent file opens must fail.
	access := uint64(1 << 2)
	ruleset, _, errno := syscall.RawSyscall(444, uintptr(unsafe.Pointer(&access)), 8, 0)
	if errno != 0 {
		fmt.Printf("ruleset creation failed: %s\n", errno)
		os.Exit(1)
	}
	defer syscall.Close(int(ruleset))
	_, _, errno = syscall.RawSyscall(446, ruleset, 0, 0)
	if errno != 0 {
		fmt.Printf("restriction failed: %s\n", errno)
		os.Exit(1)
	}
	fd, err = syscall.Open(filename, syscall.O_RDONLY, 0)
	if err == nil {
		syscall.Close(fd)
		fmt.Println("read unexpectedly allowed")
		os.Exit(1)
	}
	if err != syscall.EACCES {
		fmt.Printf("unexpected read error: %s\n", err)
		os.Exit(1)
	}
	fmt.Println("previously readable fixture denied after restriction")
}
