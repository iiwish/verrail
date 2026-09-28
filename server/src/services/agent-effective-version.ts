import { and, desc, eq } from "drizzle-orm";
import { verrailAgentDefinitions, verrailAgentVersions, verrailDeployments, verrailDeploymentRevisions, type Db } from "@paperclipai/db";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { publishAgentVersionSchema, type PublishAgentVersionInputV1 } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { VERSIONED_BEHAVIOR_KEYS } from "./agent-publication.js";

export async function readEffectiveAgentVersion(db: Db, workspaceId: string, agentId: string) {
  const [row] = await db.select({ version: verrailAgentVersions, deployment: verrailDeployments, revision: verrailDeploymentRevisions })
    .from(verrailAgentDefinitions)
    .innerJoin(verrailDeployments, and(eq(verrailDeployments.agentDefinitionId, verrailAgentDefinitions.id), eq(verrailDeployments.workspaceId, workspaceId), eq(verrailDeployments.isPrimary, true)))
    .innerJoin(verrailDeploymentRevisions, and(eq(verrailDeploymentRevisions.deploymentId, verrailDeployments.id), eq(verrailDeploymentRevisions.workspaceId, workspaceId)))
    .innerJoin(verrailAgentVersions, and(eq(verrailAgentVersions.id, verrailDeploymentRevisions.agentVersionId), eq(verrailAgentVersions.workspaceId, workspaceId), eq(verrailAgentVersions.agentDefinitionId, verrailAgentDefinitions.id)))
    .where(and(eq(verrailAgentDefinitions.compatibilityAgentId, agentId), eq(verrailAgentDefinitions.workspaceId, workspaceId)))
    .orderBy(desc(verrailDeploymentRevisions.revisionNumber)).limit(1);
  if (!row || row.deployment.status !== "active" || row.revision.state !== "active") throw new HttpError(409, "Activate an agent version before starting a new request", { code: "AGENT_VERSION_NOT_ACTIVE" });
  if (row.version.supplyChain.source !== "saved_agent_configuration.v2") throw new HttpError(409, "Publish and activate a pinned configuration version", { code: "AGENT_VERSION_REPUBLISH_REQUIRED" });
  return row;
}

export async function readManagedAgentVersion(db: Db, workspaceId: string, agentId: string) {
  const [definition] = await db.select({ id: verrailAgentDefinitions.id }).from(verrailAgentDefinitions)
    .where(and(eq(verrailAgentDefinitions.compatibilityAgentId, agentId), eq(verrailAgentDefinitions.workspaceId, workspaceId))).limit(1);
  return definition ? readEffectiveAgentVersion(db, workspaceId, agentId) : null;
}

export async function readPinnedExecutionVersion(db: Db, workspaceId: string, agentVersionId: string) {
  const [version] = await db.select().from(verrailAgentVersions)
    .where(and(eq(verrailAgentVersions.id, agentVersionId), eq(verrailAgentVersions.workspaceId, workspaceId))).limit(1);
  if (!version) throw new Error("Pinned execution version is unavailable");
  return version;
}

export function versionedAdapterConfig(live: Record<string, unknown>, rawVersion: PublishAgentVersionInputV1, agentId: string): Record<string, unknown> {
  const { runtime, model, prompt, skills, tools, outputSchema, capabilityCeiling, supplyChain } = rawVersion;
  const version = publishAgentVersionSchema.parse({ runtime, model, prompt, skills, tools, outputSchema, capabilityCeiling, supplyChain });
  const source = version.supplyChain;
  if (source.source !== "saved_agent_configuration.v2" || source.mode !== "compatibility_executor" || source.agentId !== agentId) throw new Error("Invalid execution version identity");
  const config = { ...live };
  // Authority, credentials and host settings stay live. Draft behavior never leaks into a run.
  for (const key of [...VERSIONED_BEHAVIOR_KEYS, "instructionsFilePath", "instructionsRootPath", "instructionsEntryFile", "instructionsBundleMode", "bootstrapPromptTemplate", "paperclipSkillSync"]) delete config[key];
  const settings = source.behaviorSettings as Record<string, unknown> | undefined;
  for (const key of VERSIONED_BEHAVIOR_KEYS) if (settings && ["string", "number", "boolean"].includes(typeof settings[key])) config[key] = settings[key];
  config.model = version.model;
  config.paperclipSkillSync = { desiredSkills: source.skillReferences ?? [] };
  return config;
}

export async function materializeVersionInstructions(version: PublishAgentVersionInputV1) {
  const files = version.supplyChain?.instructionFiles;
  const entry = version.supplyChain?.entryFile;
  if (!files || typeof files !== "object" || Array.isArray(files) || typeof entry !== "string" || !Object.hasOwn(files, entry)) throw new Error("Published instructions are incomplete");
  const entries = Object.entries(files);
  if (entries.length > 100 || Buffer.byteLength(JSON.stringify(files)) > 200_000) throw new Error("Published instructions exceed limits");
  for (const [name, content] of entries) if (!name || path.isAbsolute(name) || name.split(/[\\/]/).some((part) => part === ".." || part === "." || !part) || name.includes("\0") || typeof content !== "string") throw new Error("Invalid published instruction file");
  const root = await mkdtemp(path.join(tmpdir(), "verrail-agent-version-"));
  try {
    for (const [name, content] of entries) { const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content as string, { mode: 0o400 }); }
    return { root, config: { instructionsBundleMode: "external", instructionsRootPath: root, instructionsEntryFile: entry, instructionsFilePath: path.join(root, entry) } };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
