import { z } from "zod";

export function readRepositoryRecoveryConfig(env: NodeJS.ProcessEnv) {
  const databaseUrl = z.string().url().parse(env.DATABASE_URL);
  const database = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(database.protocol) || !database.hostname || !database.username || database.pathname === "/") {
    throw new Error("REPOSITORY_RECOVERY_DATABASE_INVALID");
  }
  const domainApiUrl = z.string().url().parse(env.VERRAIL_DOMAIN_API_URL);
  const domain = new URL(domainApiUrl);
  if (!["http:", "https:"].includes(domain.protocol) || domain.username || domain.password || domain.search || domain.hash) {
    throw new Error("REPOSITORY_RECOVERY_DOMAIN_INVALID");
  }
  const domainApiToken = z.string().trim().min(16).parse(env.VERRAIL_DOMAIN_API_TOKEN);
  const workspaceIds = z.array(z.string().uuid()).min(1).max(100)
    .parse(JSON.parse(env.VERRAIL_REPOSITORY_WORKSPACE_IDS ?? "[]"));
  if (new Set(workspaceIds).size !== workspaceIds.length) throw new Error("REPOSITORY_RECOVERY_DUPLICATE_WORKSPACE");
  const healthPort = z.coerce.number().int().min(0).max(65535).parse(env.VERRAIL_REPOSITORY_RECOVERY_HEALTH_PORT ?? 3213);
  return { databaseUrl, domainApiUrl, domainApiToken, workspaceIds, healthPort };
}
