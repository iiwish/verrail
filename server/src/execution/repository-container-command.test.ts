import { describe, expect, it, vi } from "vitest";
import { createRepositoryContainerCommand, repositoryContainerConfigSchema } from "./repository-container-command.js";

const checkoutRoot = "/scratch";
const cwd = "/scratch/verrail-repository-fixture/checkout";
const input = { command: "echo test", timeoutSeconds: 10 };
const finished = { status: "finished", exitCode: 7, stdout: "output", stderr: "diagnostic" };
const signal = () => new AbortController().signal;

describe("disposable repository command containers", () => {
  it("passes only bounded command data and retains identity through confirmed destruction", async () => {
    const transport = vi.fn().mockResolvedValueOnce(finished).mockResolvedValueOnce({ status: "stopped" });
    const run = createRepositoryContainerCommand({ checkoutRoot, transport });
    expect(await run({ cwd, input, signal: signal() })).toEqual({ exitCode: 7, stdout: "output", stderr: "diagnostic" });
    const start = transport.mock.calls[0][0];
    expect(start).toEqual({ version: 1, operation: "start", commandId: expect.any(String),
      workspace: "verrail-repository-fixture/checkout", ...input });
    expect(transport.mock.calls[1][0]).toEqual({ version: 1, operation: "stop", commandId: start.commandId });
  });

  it("polls without issuing a second start", async () => {
    const transport = vi.fn().mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce(finished).mockResolvedValueOnce({ status: "stopped" });
    await createRepositoryContainerCommand({ checkoutRoot, transport })({ cwd, input, signal: signal() });
    expect(transport.mock.calls.map(([packet]) => packet.operation)).toEqual(["start", "poll", "stop"]);
  });

  it("stops an ambiguous start with the same identity", async () => {
    const transport = vi.fn().mockRejectedValueOnce(new Error("lost start response"))
      .mockResolvedValueOnce({ status: "stopped" });
    await expect(createRepositoryContainerCommand({ checkoutRoot, transport })({ cwd, input, signal: signal() }))
      .rejects.toThrow("lost start response");
    expect(transport.mock.calls[1][0].commandId).toBe(transport.mock.calls[0][0].commandId);
  });

  it("does not claim cleanup when the gateway cannot confirm destruction", async () => {
    const transport = vi.fn().mockResolvedValueOnce(finished).mockRejectedValueOnce(new Error("engine down"));
    await expect(createRepositoryContainerCommand({ checkoutRoot, transport })({ cwd, input, signal: signal() }))
      .rejects.toThrow("REPOSITORY_COMMAND_CLEANUP_FAILED");
  });

  it("requires a stopped acknowledgement, not a transport success", async () => {
    const transport = vi.fn().mockResolvedValueOnce(finished).mockResolvedValueOnce({ status: "running" });
    await expect(createRepositoryContainerCommand({ checkoutRoot, transport })({ cwd, input, signal: signal() }))
      .rejects.toThrow("REPOSITORY_COMMAND_CLEANUP_FAILED");
  });

  it("cancels an active container with an independent cleanup signal", async () => {
    const abort = new AbortController();
    const transport = vi.fn(async (packet, currentSignal) => {
      if (packet.operation === "start") { abort.abort(); return { status: "running" }; }
      expect(currentSignal.aborted).toBe(false);
      return { status: "stopped" };
    });
    await expect(createRepositoryContainerCommand({ checkoutRoot, transport })({ cwd, input, signal: abort.signal }))
      .rejects.toThrow();
    expect(transport.mock.calls.map(([packet]) => packet.operation)).toEqual(["start", "stop"]);
  });

  it("does not admit canceled work", async () => {
    const transport = vi.fn();
    await expect(createRepositoryContainerCommand({ checkoutRoot, transport })({ cwd, input, signal: AbortSignal.abort() }))
      .rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["/etc", "/scratch/../secrets", "/scratch/verrail-repository-x/../checkout", "/scratch/verrail-repository-x/checkout/nested"])
    ("rejects paths outside the fixed checkout contract: %s", async bad => {
      const transport = vi.fn();
      await expect(createRepositoryContainerCommand({ checkoutRoot, transport })({ cwd: bad, input, signal: signal() }))
        .rejects.toThrow("REPOSITORY_CONTAINER_INPUT_INVALID");
      expect(transport).not.toHaveBeenCalled();
    });

  it.each(["timeout", "output_limit", "execution_failed"])("preserves %s failures after cleanup", async error => {
    const transport = vi.fn().mockResolvedValueOnce({ ...finished, error }).mockResolvedValueOnce({ status: "stopped" });
    await expect(createRepositoryContainerCommand({ checkoutRoot, transport })({ cwd, input, signal: signal() }))
      .rejects.toThrow(/REPOSITORY_COMMAND_/);
    expect(transport.mock.calls[1][0].operation).toBe("stop");
  });

  it("bounds combined response bytes and rejects protocol additions", async () => {
    for (const reply of [{ ...finished, stdout: "x".repeat(800_000), stderr: "y".repeat(800_000) },
      { ...finished, credentials: "must-not-be-accepted" }]) {
      const transport = vi.fn().mockResolvedValueOnce(reply).mockResolvedValueOnce({ status: "stopped" });
      await expect(createRepositoryContainerCommand({ checkoutRoot, transport })({ cwd, input, signal: signal() })).rejects.toThrow();
    }
  });

  it("rejects SSH destination options and relative credential paths", () => {
    expect(() => repositoryContainerConfigSchema.parse({ destination: "-oProxyCommand=bad", identityFile: "/key", knownHostsFile: "/hosts" })).toThrow();
    expect(() => repositoryContainerConfigSchema.parse({ destination: "runner@maco", identityFile: "key", knownHostsFile: "/hosts" })).toThrow();
  });
});
