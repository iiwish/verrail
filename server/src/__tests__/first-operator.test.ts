import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authAccounts, authUsers, createDb, instanceUserRoles } from "@paperclipai/db";
import { bootstrapFirstOperator } from "../services/first-operator.js";
import { claimFirstInstanceAdmin } from "../first-admin-claim.js";
import { createBetterAuthHandler, createBetterAuthInstance } from "../auth/better-auth.js";
import { loadConfig } from "../config.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("first operator bootstrap", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const input = { name: "Test Operator", email: "OPERATOR@example.test", password: "fixture-password-0123456789" };
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("verrail-first-operator-");
    db = createDb(fixture.connectionString);
    vi.stubEnv("BETTER_AUTH_SECRET", "fixture-auth-secret-012345678901234567890123");
    vi.stubEnv("PAPERCLIP_AUTH_RATE_LIMIT_ENABLED", "false");
  });
  afterEach(async () => { await db.delete(authUsers); await db.delete(instanceUserRoles); });
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await fixture?.cleanup(); vi.unstubAllEnvs(); });

  it("permits real password login while public signup stays disabled", async () => {
    const result = await bootstrapFirstOperator(db, input);
    expect(result.status).toBe("created");
    const roles = await db.select().from(instanceUserRoles);
    expect(roles).toHaveLength(1);
    expect(roles[0].userId).toBe(result.userId);
    const accounts = await db.select().from(authAccounts);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].password).not.toBe(input.password);
    const auth = createBetterAuthInstance(db, { ...loadConfig(), deploymentMode: "authenticated", deploymentExposure: "private", authBaseUrlMode: "explicit", authPublicBaseUrl: "http://localhost", authDisableSignUp: true }, ["http://localhost"]);
    const app = express();
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
    const signup = await request(app).post("/api/auth/sign-up/email").set("Origin", "http://localhost").send({ ...input, email: "other@example.test" });
    expect(signup.status).toBe(400);
    const login = await request(app).post("/api/auth/sign-in/email").set("Origin", "http://localhost").send({ email: input.email.toLowerCase(), password: input.password });
    expect(login.status).toBe(200);
    expect(login.body.user.id).toBe(result.userId);
    expect(login.headers["set-cookie"]).toBeDefined();
    const invalid = await request(app).post("/api/auth/sign-in/email").set("Origin", "http://localhost").send({ email: input.email.toLowerCase(), password: "not-the-password" });
    expect(invalid.status).toBe(401);
    const repeat = await bootstrapFirstOperator(db, { ...input, password: "different-valid-password" });
    expect(repeat).toEqual({ status: "already_initialized" });
    expect((await db.select().from(authAccounts))[0].password).toBe(accounts[0].password);
  });

  it("serializes competing initializers without orphan accounts", async () => {
    const results = await Promise.all([
      bootstrapFirstOperator(db, input),
      bootstrapFirstOperator(db, { ...input, email: "second@example.test" }),
    ]);
    expect(results.map(result => result.status).sort()).toEqual(["already_initialized", "created"]);
    expect(await db.select().from(authUsers)).toHaveLength(1);
    expect(await db.select().from(authAccounts)).toHaveLength(1);
    expect(await db.select().from(instanceUserRoles)).toHaveLength(1);
  });

  it("never elevates an existing account or leaves a partial admin grant", async () => {
    const timestamp = new Date();
    await db.insert(authUsers).values({ id: randomUUID(), name: "Existing", email: input.email.toLowerCase(), createdAt: timestamp, updatedAt: timestamp });
    await expect(bootstrapFirstOperator(db, input)).rejects.toThrow("already exists");
    expect(await db.select().from(instanceUserRoles)).toHaveLength(0);
    expect(await db.select().from(authAccounts)).toHaveLength(0);
    expect(await db.select().from(authUsers)).toHaveLength(1);
    await claimFirstInstanceAdmin(db, { userId: "existing-admin" });
    expect(await bootstrapFirstOperator(db, { ...input, email: "new@example.test" })).toEqual({ status: "already_initialized" });
    expect(await db.select().from(authUsers)).toHaveLength(1);
  });

  it("rejects weak passwords and unexpected authority fields before writing", async () => {
    await expect(bootstrapFirstOperator(db, { ...input, password: "short" })).rejects.toThrow();
    await expect(bootstrapFirstOperator(db, { ...input, role: "admin" })).rejects.toThrow();
    expect(await db.select().from(authUsers)).toHaveLength(0);
    expect(await db.select().from(instanceUserRoles)).toHaveLength(0);
  });
});
