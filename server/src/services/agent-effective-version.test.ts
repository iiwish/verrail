import { describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { materializeVersionInstructions, versionedAdapterConfig } from "./agent-effective-version.js";
import type { PublishAgentVersionInputV1 } from "@paperclipai/shared";

const version: PublishAgentVersionInputV1 = {
  runtime: "codex_local", model: "pinned-model", prompt: "Pinned instructions", skills: [], tools: [], outputSchema: {}, capabilityCeiling: [],
  supplyChain: { source: "saved_agent_configuration.v2", mode: "compatibility_executor", agentId: "agent", entryFile: "AGENTS.md",
    instructionFiles: { "AGENTS.md": "Pinned instructions", "nested/style.md": "Pinned style" }, behaviorSettings: { temperature: 0.2, promptTemplate: "Pinned template", dangerouslySkipPermissions: true },
    skillReferences: [{ key: "skill", versionId: "immutable-skill-version" }] },
};
describe("effective agent configuration", () => {
  it("uses the published behavior while preserving current authority and secrets", () => {
    const live = { model: "draft-model", temperature: 0.9, promptTemplate: "Draft", bootstrapPromptTemplate: "Draft bootstrap", instructionsFilePath: "/draft/AGENTS.md", env: { TOKEN: "current" }, dangerouslySkipPermissions: false, cwd: "/current" };
    const config = versionedAdapterConfig(live, { ...version, id: "database-row-id" } as typeof version, "agent");
    expect(config).toMatchObject({ model: "pinned-model", temperature: 0.2, promptTemplate: "Pinned template", env: { TOKEN: "current" }, dangerouslySkipPermissions: false, cwd: "/current" });
    expect(config).not.toHaveProperty("bootstrapPromptTemplate");
    expect(config).not.toHaveProperty("instructionsFilePath");
    expect(config.paperclipSkillSync).toEqual({ desiredSkills: [{ key: "skill", versionId: "immutable-skill-version" }] });
    expect(live.model).toBe("draft-model");
    expect(() => versionedAdapterConfig(live, version, "foreign-agent")).toThrow("identity");
    expect(() => versionedAdapterConfig(live, { ...version, supplyChain: { ...version.supplyChain, mode: "director_chat" } }, "agent")).toThrow("identity");
  });
  it("materializes isolated immutable instruction snapshots without touching the draft", async () => {
    const result = await materializeVersionInstructions(version);
    try {
      expect(await readFile(result.config.instructionsFilePath, "utf8")).toBe("Pinned instructions");
      expect(await readFile(path.join(result.root, "nested/style.md"), "utf8")).toBe("Pinned style");
      const second = await materializeVersionInstructions(version);
      expect(second.root).not.toBe(result.root);
      await rm(second.root, { recursive: true, force: true });
    } finally { await rm(result.root, { recursive: true, force: true }); }
  });
  it.each(["../escape", "/absolute", "nested/../escape", "nested\\..\\escape", "./entry"])("rejects unsafe snapshot path %s", async (entry) => {
    await expect(materializeVersionInstructions({ ...version, supplyChain: { ...version.supplyChain, entryFile: entry, instructionFiles: { [entry]: "unsafe" } } })).rejects.toThrow("Invalid published");
  });
});
