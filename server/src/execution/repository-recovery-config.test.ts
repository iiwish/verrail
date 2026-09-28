import { expect, it } from "vitest";
import { readRepositoryRecoveryConfig } from "./repository-recovery-config.js";

const env = { DATABASE_URL: "postgres://runtime:fixture@pg-main/verrail_test",
  VERRAIL_DOMAIN_API_URL: "http://domain-api:8080", VERRAIL_DOMAIN_API_TOKEN: "fixture-token-123456",
  VERRAIL_REPOSITORY_WORKSPACE_IDS: '["11111111-1111-4111-8111-111111111111"]' };

it("requires explicit external PostgreSQL and workspace scope", () => {
  expect(readRepositoryRecoveryConfig(env)).toMatchObject({ databaseUrl: env.DATABASE_URL,
    workspaceIds: ["11111111-1111-4111-8111-111111111111"] });
  for (const overrides of [{ DATABASE_URL: "file:/tmp/db" }, { DATABASE_URL: "postgres://runtime@pg-main/" },
    { VERRAIL_REPOSITORY_WORKSPACE_IDS: "[]" }, { VERRAIL_REPOSITORY_WORKSPACE_IDS: "{}" },
    { VERRAIL_REPOSITORY_WORKSPACE_IDS: '["invalid"]' }, { VERRAIL_DOMAIN_API_TOKEN: "" },
    { VERRAIL_DOMAIN_API_URL: "file:/tmp/domain" }, { VERRAIL_DOMAIN_API_URL: "http://user:secret@domain-api/" },
    { VERRAIL_DOMAIN_API_URL: "http://domain-api/?token=secret" }]) {
    expect(() => readRepositoryRecoveryConfig({ ...env, ...overrides })).toThrow();
  }
});

it("rejects duplicate workspace scopes", () => {
  expect(() => readRepositoryRecoveryConfig({ ...env, VERRAIL_REPOSITORY_WORKSPACE_IDS:
    JSON.stringify(Array(2).fill("11111111-1111-4111-8111-111111111111")) })).toThrow("DUPLICATE_WORKSPACE");
});
