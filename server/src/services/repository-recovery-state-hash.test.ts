import { getTableColumns, getTableName } from "drizzle-orm";
import {
  verrailArtifacts,
  verrailArtifactRevisions,
  verrailAuditEvents,
  verrailExecutionCommandReceipts,
  verrailExecutionLeases,
  verrailRunAttempts,
  verrailRunEvents,
  verrailRuns,
} from "@paperclipai/db";
import { describe, expect, it } from "vitest";
import { repositoryRecoveryStateSha256 } from "./repository-recovery-state-hash.js";

const tables = [verrailRunAttempts, verrailExecutionLeases, verrailRuns, verrailRunEvents,
  verrailExecutionCommandReceipts, verrailAuditEvents, verrailArtifacts, verrailArtifactRevisions];
const expectedColumns: Record<string, string> = {
  verrail_run_attempts: "id workspace_id run_id attempt_number deployment_revision_id agent_version_id runtime_profile executor_principal_type executor_principal_id fencing_token status last_event_cursor error_code error_message result idempotency_key started_at finished_at created_at updated_at",
  verrail_execution_leases: "id workspace_id run_id run_attempt_id executor_principal_id runtime_profile fencing_token status expires_at grace_expires_at claimed_at last_heartbeat_at released_at created_at updated_at",
  verrail_runs: "id workspace_id target_id target_revision_id graph_revision_id work_node_id kind status actor_principal_type actor_principal_id actor_display_name deployment_revision_id agent_version_id attempt_count cancel_requested_at idempotency_key started_at finished_at created_at updated_at",
  verrail_run_events: "id workspace_id run_id run_attempt_id cursor fencing_token event_type payload content_hash emitted_at received_at",
  verrail_execution_command_receipts: "id workspace_id principal_type principal_id command_type idempotency_key request_hash response created_at",
  verrail_audit_events: "id workspace_id principal_type principal_id event_type aggregate_type aggregate_id idempotency_key payload occurred_at",
  verrail_artifacts: "id workspace_id target_id kind title created_by_principal_type created_by_principal_id created_at updated_at",
  verrail_artifact_revisions: "id workspace_id artifact_id revision_number content_hash content_ref source_run_id source_work_node_id base_revision_id created_by_principal_type created_by_principal_id created_at",
};
const databaseTime = "2026-10-16T13:14:15.123987+09:00";
const normalizedTime = "2026-10-16T04:14:15.123Z";
const payload = JSON.parse('{"created_at":"not-a-date","nested_key":{"received_at":null,"fraction":0.125},"10":"ten","2":"two","A":true,"a":false,"\\ue000":"bmp","\\ud800\\udc00":"astral","\\u4e2d\\u6587":"<&\\u2028\\u2029"}');
const jsonProjection = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

function syntheticDrizzleRow(table: typeof tables[number], nullable: boolean): Record<string, unknown> {
  return Object.fromEntries(Object.entries(getTableColumns(table)).map(([property, column]) => {
    if (nullable && !column.notNull) return [property, null];
    const driverValue = column.dataType === "date" ? databaseTime
      : column.dataType === "number" ? 17
        : column.dataType === "json" ? payload
          : column.columnType === "PgUUID" ? "00000000-0000-4000-8000-000000000001" : `synthetic:${property}`;
    return [property, column.mapFromDriverValue(driverValue)];
  }));
}

const vectorValues: Array<{ name: string; value: unknown }> = [
  { name: "null", value: null },
  { name: "booleans", value: [true, false] },
  { name: "fractional-json", value: { cost: 0.125, reportedCostUsd: 1.23456789012345, negative: -42.5 } },
  { name: "finite-extremes", value: [1e308, -1e308, 1e-300, -1e-300, Number.MIN_VALUE, Number.MAX_VALUE] },
  { name: "negative-zero", value: -0 },
  { name: "numeric-looking-keys", value: { "10": "ten", "2": "two", "01": "one", "4294967295": "not-an-array-index" } },
  { name: "mixed-case-unicode-keys", value: payload },
  { name: "nested-array-and-null", value: [null, { items: [1.5, false, "", { nullable: null }] }, []] },
  { name: "normalized-date-string", value: { createdAt: normalizedTime, finishedAt: null } },
  ...tables.flatMap(table => [false, true].map(nullable => ({
    name: `synthetic-drizzle-${getTableName(table)}-${nullable ? "nullable" : "populated"}`,
    value: jsonProjection(syntheticDrizzleRow(table, nullable)),
  }))),
];

describe("repository recovery database state fingerprints", () => {
  it("exports reproducible synthetic cross-language vectors from the production helper", () => {
    const vectors = vectorValues.map(({ name, value }) => ({ name, value: jsonProjection(value), sha256: repositoryRecoveryStateSha256(value) }));
    expect(vectors).toHaveLength(25);
    expect(vectors.every(vector => /^[0-9a-f]{64}$/.test(vector.sha256))).toBe(true);
    for (const vector of vectors) expect(repositoryRecoveryStateSha256(vector.value)).toBe(vector.sha256);
    if (process.env.VERRAIL_RECOVERY_STATE_INTEROP === "1") {
      process.stdout.write(`RECOVERY_STATE_HASH_SYNTHETIC_INTEROP ${JSON.stringify({ synthetic: true, cases: vectors })}\n`);
    }
  });

  it.each(tables)("maps every complete Drizzle row without rewriting JSON payload keys ($name)", table => {
    const columns = getTableColumns(table);
    expect(Object.values(columns).map(column => column.name).sort()).toEqual(expectedColumns[getTableName(table)]!.split(" ").sort());
    for (const [property, column] of Object.entries(columns)) {
      expect(property).toBe(column.name.replace(/_([a-z])/g, (_: string, letter: string) => letter.toUpperCase()));
      expect(column.name.endsWith("_at")).toBe(column.dataType === "date");
    }
    const row = jsonProjection(syntheticDrizzleRow(table, false)) as Record<string, unknown>;
    const nullable = jsonProjection(syntheticDrizzleRow(table, true)) as Record<string, unknown>;
    expect(Object.keys(row)).toEqual(Object.keys(columns));
    for (const [property, column] of Object.entries(columns)) {
      if (column.dataType === "date") expect(row[property]).toBe(normalizedTime);
      if (!column.notNull) expect(nullable[property]).toBeNull();
      if (column.dataType === "json") expect(row[property]).toEqual(payload);
    }
  });

  it("uses the actual timestamp column mapper for microseconds, offsets, and pre-epoch values", () => {
    const column = verrailRunAttempts.createdAt;
    const mapped = column.mapFromDriverValue(databaseTime);
    const beforeEpoch = column.mapFromDriverValue("1969-12-31T23:59:59.999999Z");
    expect(mapped).toBeInstanceOf(Date);
    expect(beforeEpoch).toBeInstanceOf(Date);
    if (!(mapped instanceof Date) || !(beforeEpoch instanceof Date)) throw new Error("Drizzle must return Date instances");
    expect(mapped.toISOString()).toBe(normalizedTime);
    expect(beforeEpoch.toISOString()).toBe("1969-12-31T23:59:59.999Z");
    expect(repositoryRecoveryStateSha256({ createdAt: column.mapFromDriverValue(databaseTime) }))
      .toBe(repositoryRecoveryStateSha256({ createdAt: normalizedTime }));
  });

  it("preserves types, array order, JSON field names and parent Artifact metadata", () => {
    expect(repositoryRecoveryStateSha256(-0)).toBe(repositoryRecoveryStateSha256(0));
    expect(repositoryRecoveryStateSha256({ a: 1, A: 2 })).toBe(repositoryRecoveryStateSha256({ A: 2, a: 1 }));
    expect(repositoryRecoveryStateSha256([1, 2])).not.toBe(repositoryRecoveryStateSha256([2, 1]));
    expect(repositoryRecoveryStateSha256({ created_at: "value" })).not.toBe(repositoryRecoveryStateSha256({ createdAt: "value" }));
    expect(repositoryRecoveryStateSha256(1)).not.toBe(repositoryRecoveryStateSha256("1"));
    const artifact = syntheticDrizzleRow(verrailArtifacts, false);
    const digest = repositoryRecoveryStateSha256(artifact);
    for (const property of Object.keys(artifact)) {
      expect(repositoryRecoveryStateSha256({ ...artifact, [property]: null })).not.toBe(digest);
    }
  });

  it.each([NaN, Infinity, -Infinity])("rejects nonfinite numeric input before JSON null coercion (%s)", value => {
    expect(() => repositoryRecoveryStateSha256(value)).toThrow("REPOSITORY_RECOVERY_STATE_INVALID");
    expect(() => repositoryRecoveryStateSha256({ nested: [value] })).toThrow("REPOSITORY_RECOVERY_STATE_INVALID");
  });

  it("rejects invalid database dates before Date.toJSON can coerce them to null", () => {
    const invalidDate = verrailRunAttempts.createdAt.mapFromDriverValue("infinity");
    if (!(invalidDate instanceof Date)) throw new Error("Drizzle must return a Date instance");
    expect(Number.isNaN(invalidDate.getTime())).toBe(true);
    expect(() => repositoryRecoveryStateSha256({ claimedAt: invalidDate }))
      .toThrow("REPOSITORY_RECOVERY_STATE_INVALID");
  });

  it("rejects an encoded state beyond 16 MiB", () => {
    expect(() => repositoryRecoveryStateSha256("x".repeat(16 * 1024 * 1024)))
      .toThrow("REPOSITORY_RECOVERY_STATE_TOO_LARGE");
  });
});
