import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { publicationHash, readAgentPublication } from "./agent-publication.js";

const exportFiles = vi.hoisted(() => vi.fn());
vi.mock("./agent-instructions.js", () => ({ agentInstructionsService: () => ({ exportFiles }) }));
const agent = { id: "agent", companyId: "workspace", name: "Specialist", metadata: {}, adapterType: "codex_local", adapterConfig: { model: "model", env: { API_KEY: "do-not-copy" } }, capabilities: "description, not role instructions" };
const database = (rows: unknown[]) => ({ select: () => ({ from: () => ({ where: async () => rows }) }) }) as unknown as Db;
beforeEach(() => exportFiles.mockResolvedValue({ files: { "AGENTS.md": "Actual saved behavior", "STYLE.md": "Style instructions" }, entryFile: "AGENTS.md", warnings: [] }));
afterEach(() => vi.unstubAllEnvs());
describe("saved agent publication", () => {
  it("pins an OpenCode Director provider/model and rejects implicit model selection", async () => {
    vi.stubEnv("VERRAIL_CHAT_RUNTIME", "opencode");
    vi.stubEnv("VERRAIL_CHAT_MODEL", "fixture/test");
    const director = { ...agent, metadata: { paperclipBuiltInAgent: { key: "director" } } };
    const result = await readAgentPublication(database([director]), "workspace", "agent");
    expect(result.snapshot).toMatchObject({ runtime: "opencode", model: "fixture/test", supplyChain: { mode: "director_chat" } });
    expect(JSON.stringify(result)).not.toContain("do-not-copy");
    vi.stubEnv("VERRAIL_CHAT_MODEL", "default-model");
    await expect(readAgentPublication(database([director]), "workspace", "agent")).rejects.toMatchObject({ status: 422 });
  });
  it("publishes saved instruction files, not descriptive capabilities or secrets", async () => {
    const result = await readAgentPublication(database([agent]), "workspace", "agent");
    expect(result.snapshot.prompt).toBe("Actual saved behavior");
    expect(result.snapshot.supplyChain?.instructionFiles).toEqual({ "AGENTS.md": "Actual saved behavior", "STYLE.md": "Style instructions" });
    expect(JSON.stringify(result)).not.toContain("do-not-copy");
    expect(result.sourceHash).toBe(publicationHash(result.snapshot));
  });
  it("fingerprints runtime changes and canonicalizes JSON key ordering", async () => {
    expect(publicationHash({ a: 1, b: 2 })).toBe(publicationHash({ b: 2, a: 1 }));
    const before = await readAgentPublication(database([agent]), "workspace", "agent");
    const after = await readAgentPublication(database([{ ...agent, adapterConfig: { ...agent.adapterConfig, model: "other" } }]), "workspace", "agent");
    expect(after.sourceHash).not.toBe(before.sourceHash);
  });
  it("rejects missing agents and oversized bundles", async () => {
    await expect(readAgentPublication(database([]), "workspace", "absent")).rejects.toMatchObject({ status: 404 });
    exportFiles.mockResolvedValue({ files: { "AGENTS.md": "x".repeat(200_001) }, entryFile: "AGENTS.md", warnings: [] });
    await expect(readAgentPublication(database([agent]), "workspace", "agent")).rejects.toMatchObject({ status: 422 });
  });
});
