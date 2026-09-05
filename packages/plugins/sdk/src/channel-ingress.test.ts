import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it, vi } from "vitest";
import type { ChannelIngressRequestV1 } from "@paperclipai/shared";
import { createHostClientHandlers, type HostServices } from "./host-client-factory.js";
import { definePlugin } from "./define-plugin.js";
import { startWorkerRpcHost } from "./worker-rpc-host.js";

const input = { workspaceId: "workspace-a" } as ChannelIngressRequestV1;

describe("channel ingress authority", () => {
  it("gates background ingress and rejects invalid or mismatched invocation scopes", async () => {
    const ingest = vi.fn().mockResolvedValue({ duplicate: false });
    const services = { channels: { ingest } } as unknown as HostServices;
    const denied = createHostClientHandlers({ pluginId: "test", capabilities: [], services });
    await expect(denied["channels.ingest"](input)).rejects.toMatchObject({ name: "CapabilityDeniedError" });
    const allowed = createHostClientHandlers({ pluginId: "test", capabilities: ["webhooks.receive"], services });
    await expect(allowed["channels.ingest"](input, { invalidInvocationScope: true })).rejects.toMatchObject({ name: "InvocationScopeDeniedError" });
    await expect(allowed["channels.ingest"](input, { invocationScope: { companyId: "workspace-b" } })).rejects.toMatchObject({ name: "InvocationScopeDeniedError" });
    expect(ingest).not.toHaveBeenCalled();
    await allowed["channels.ingest"](input);
    expect(ingest).toHaveBeenCalledWith(input);
  });

  it("does not retain a configuration invocation on background ingress, while secrets retain it", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const lines = createInterface({ input: stdout });
    const requests: Array<{ method: string; paperclipInvocationId?: string }> = [];
    const pending = new Map<string, (value: unknown) => void>();
    let callback!: () => Promise<void>;
    let ctx!: Parameters<NonNullable<Parameters<typeof definePlugin>[0]["setup"]>>[0];
    const worker = startWorkerRpcHost({ stdin, stdout, plugin: definePlugin({
      multiCompanyConfig: true,
      async setup(value) { ctx = value; },
      async onConfigChanged() {
        await ctx.secrets.resolve({ type: "secret_ref", secretId: "test" }, { companyId: "workspace-a" });
        callback = () => ctx.channels!.ingest(input).then(() => undefined);
        await callback();
      },
    }) });
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method && message.id) {
        requests.push(message);
        stdin.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\n");
      } else if (message.id) pending.get(message.id)?.(message);
    });
    function call(id: string, method: string, params: unknown, paperclipInvocation?: unknown) {
      const result = new Promise<unknown>((resolve) => pending.set(id, resolve));
      stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params, paperclipInvocation }) + "\n");
      return result;
    }
    try {
      await call("init", "initialize", { manifest: { id: "test", capabilities: ["webhooks.receive", "secrets.read-ref"] }, config: {}, instanceInfo: { instanceId: "test", hostVersion: "0.0.0" }, apiVersion: 1 });
      const response = await call("config", "configChanged", { config: {}, companyId: "workspace-a" }, { id: "configuration", scope: { companyId: "workspace-a" } });
      expect(response).not.toHaveProperty("error");
      await callback();
      expect(requests.filter((r) => r.method === "secrets.resolve")).toEqual([expect.objectContaining({ paperclipInvocationId: "configuration" })]);
      expect(requests.filter((r) => r.method === "channels.ingest")).toHaveLength(2);
      expect(requests.filter((r) => r.method === "channels.ingest").every((r) => !r.paperclipInvocationId)).toBe(true);
    } finally {
      worker.stop(); lines.close(); stdin.destroy(); stdout.destroy();
    }
  });
});
