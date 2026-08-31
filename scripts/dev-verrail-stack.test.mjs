import assert from "node:assert/strict";
import test from "node:test";
import { buildStackConfig } from "./dev-verrail-stack.mjs";

test("builds one shared local runtime configuration", () => {
  const config = buildStackConfig({});

  assert.equal(config.databaseUrl, "postgres://verrail:verrail@127.0.0.1:55432/verrail");
  assert.equal(config.runtimeEnv.DATABASE_URL, config.databaseUrl);
  assert.equal(config.runtimeEnv.DATABASE_MIGRATION_URL, config.databaseUrl);
  assert.equal(config.runtimeEnv.TEMPORAL_ADDRESS, "127.0.0.1:57233");
  assert.equal(config.runtimeEnv.VERRAIL_DOMAIN_API_AUTOSTART, "true");
  assert.equal(config.runtimeEnv.VERRAIL_TEMPORAL_TASK_QUEUE, "verrail-target-v1");
});

test("honors explicit ports and shared service endpoints", () => {
  const config = buildStackConfig({
    PORT: "3320",
    VERRAIL_DEV_POSTGRES_PORT: "55439",
    VERRAIL_DEV_TEMPORAL_GRPC_PORT: "57239",
    VERRAIL_DEV_TEMPORAL_UI_PORT: "58239",
    VERRAIL_DEV_DATABASE_URL: "postgres://custom/custom",
    TEMPORAL_ADDRESS: "temporal.example:7233",
  });

  assert.equal(config.appPort, 3320);
  assert.equal(config.composeEnv.VERRAIL_DEV_POSTGRES_PORT, "55439");
  assert.equal(config.databaseUrl, "postgres://custom/custom");
  assert.equal(config.temporalAddress, "temporal.example:7233");
});

test("rejects invalid local ports", () => {
  assert.throws(() => buildStackConfig({ PORT: "70000" }), /PORT must be an integer/);
  assert.throws(() => buildStackConfig({ VERRAIL_DEV_POSTGRES_PORT: "none" }), /VERRAIL_DEV_POSTGRES_PORT/);
});
