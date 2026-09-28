import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandVersion, runCommand } from "./mcp-isolation-harness.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));

function fixture(pid?: number) {
  const child = Object.assign(new EventEmitter(), { pid, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  spawn.mockReturnValue(child);
  return child;
}

describe("MCP isolation command cleanup", () => {
  beforeEach(() => { vi.useFakeTimers(); spawn.mockReset(); vi.spyOn(process, "kill").mockReturnValue(true); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("clears the deadline when an optional CLI cannot spawn", async () => {
    const child = fixture();
    const result = commandVersion("missing-cli");
    child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    await expect(result).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(6000);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("waits for pipe close so output after exit is retained", async () => {
    const child = fixture(12345);
    const result = runCommand("fixture", []);
    child.emit("exit", 0, null);
    child.stdout.write("final stdout"); child.stderr.write("final stderr");
    child.emit("close", 0, null);
    await expect(result).resolves.toMatchObject({ exitCode: 0, stdout: "final stdout", stderr: "final stderr", timedOut: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("signals only the spawned command group at its deadline", async () => {
    const child = fixture(12345);
    const result = runCommand("fixture", [], { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    if (process.platform === "win32") expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    else expect(process.kill).toHaveBeenCalledWith(-12345, "SIGTERM");
    child.emit("close", null, "SIGTERM");
    await expect(result).resolves.toMatchObject({ signal: "SIGTERM", timedOut: true });
  });

  it.skipIf(process.platform === "win32")("tolerates a group that exits concurrently with its deadline", async () => {
    const child = fixture(12345);
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    const result = runCommand("fixture", [], { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    child.emit("close", 0, null);
    await expect(result).resolves.toMatchObject({ exitCode: 0, timedOut: true });
  });
});
