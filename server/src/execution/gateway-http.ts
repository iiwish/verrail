import { timingSafeEqual } from "node:crypto";
import express from "express";
import { z } from "zod";
import { executionGatewayRequestSchema } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import type { createExecutionGatewayStore } from "./gateway-store.js";

export function createExecutionGatewayApp(store: Awaited<ReturnType<typeof createExecutionGatewayStore>>, serviceToken: string) {
  if (serviceToken.length < 32) throw new Error("Gateway service token is required");
  const expected = Buffer.from(`Bearer ${serviceToken}`);
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) => { res.status(store.healthy() ? 200 : 503).json({ healthy: store.healthy() }); });
  app.use((req, res, next) => {
    const actual = Buffer.from(req.get("authorization") ?? "");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "2mb" }));
  app.post("/v1/invocations", async (req, res) => {
    const result = await store.submit(executionGatewayRequestSchema.parse(req.body));
    res.status(result.replayed ? 200 : 202).json(result);
  });
  app.get("/v1/invocations/:id", async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const query = z.object({ workspaceId: z.string().uuid(), after: z.coerce.number().int().min(0).max(2147483647).default(0) }).strict().parse(req.query);
    res.json(await store.read(query.workspaceId, id, query.after));
  });
  app.post("/v1/invocations/:id/cancel", async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = z.object({ workspaceId: z.string().uuid() }).strict().parse(req.body);
    await store.cancel(input.workspaceId, id);
    res.status(202).json({ invocationId: id });
  });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const oversized = typeof error === "object" && error !== null && "type" in error && error.type === "entity.too.large";
    const status = error instanceof HttpError ? error.status : oversized ? 413 : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500;
    res.status(status).json({ error: status >= 500 ? "Gateway unavailable" : "Gateway request rejected" });
  });
  return app;
}
