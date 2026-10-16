import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agents, companySkills, companySkillVersions, type Db } from "@paperclipai/db";
import { isWorkspaceDirector, publishAgentVersionSchema, type AgentPublicationPreviewV1 } from "@paperclipai/shared";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { HttpError } from "../errors.js";
import { agentInstructionsService } from "./agent-instructions.js";
import { resolveDirectorRole, resolveDirectorChatRuntime, DIRECTOR_POLICY_VERSION } from "./director-instructions.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}

export function publicationHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export const VERSIONED_BEHAVIOR_KEYS = ["promptTemplate", "modelReasoningEffort", "reasoningEffort", "fastMode", "temperature", "maxTurns"] as const;

export async function readAgentPublication(db: Db, workspaceId: string, agentId: string): Promise<AgentPublicationPreviewV1> {
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, workspaceId)));
  if (!agent) throw new HttpError(404, "Agent not found");
  const config = agent.adapterConfig ?? {};
  const director = isWorkspaceDirector(agent.metadata);
  const bundle = director ? null : await agentInstructionsService().exportFiles(agent, { recover: false, maxFiles: 100, maxBytes: 200_000 });
  const files = bundle?.files ?? {};
  if (Object.keys(files).length > 100 || Buffer.byteLength(JSON.stringify(files)) > 200_000) {
    throw new HttpError(422, "Instruction bundle exceeds the publication limit (100 files / 200 KB)");
  }
  const skills = director ? [] : readPaperclipSkillSyncPreference(config).desiredSkillEntries;
  for (const entry of skills) {
    const [skill] = await db.select().from(companySkills).where(and(eq(companySkills.companyId, workspaceId), eq(companySkills.key, entry.key)));
    const id = entry.versionId ?? skill?.currentVersionId;
    if (!skill || !id) throw new HttpError(422, `Publish skill ${entry.key} before publishing this agent`);
    const [version] = await db.select().from(companySkillVersions).where(and(eq(companySkillVersions.id, id), eq(companySkillVersions.companyId, workspaceId), eq(companySkillVersions.companySkillId, skill.id)));
    if (!version) throw new HttpError(422, `Skill version unavailable: ${entry.key}`);
    entry.versionId = id;
  }
  const behaviorSettings = director ? {} : Object.fromEntries(
    VERSIONED_BEHAVIOR_KEYS
      .filter((key) => ["string", "boolean", "number"].includes(typeof config[key]))
      .map((key) => [key, config[key]]),
  );
  const prompt = director ? resolveDirectorRole(config).rolePrompt : files[bundle!.entryFile];
  const runtime = director ? resolveDirectorChatRuntime() : agent.adapterType;
  const model = (director && process.env.VERRAIL_CHAT_MODEL?.trim()) || (typeof config.model === "string" && config.model.trim() ? config.model.trim() : "unconfigured");
  if (runtime === "opencode" && !/^[^/\s]+\/\S+$/.test(model)) throw new HttpError(422, "Configure an explicit provider/model for OpenCode before publishing");
  const snapshot = publishAgentVersionSchema.parse({
    runtime,
    model,
    prompt,
    skills: skills.map((entry) => entry.key), tools: [], outputSchema: {}, capabilityCeiling: [],
    supplyChain: {
      source: "saved_agent_configuration.v2", agentId,
      mode: director ? "director_chat" : "compatibility_executor",
      instructionFiles: files, entryFile: bundle?.entryFile ?? null,
      behaviorSettings,
      skillReferences: skills,
      ...(director ? { policyVersion: DIRECTOR_POLICY_VERSION } : {}),
    },
  });
  return { agentId, sourceHash: publicationHash(snapshot), snapshot, warnings: bundle?.warnings ?? [], mode: director ? "director_chat" : "compatibility_executor" };
}
