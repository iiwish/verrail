import { createHash, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { registerRepositorySource } from "./repository-source-registration.js";

function fixture() {
  const bundle = Buffer.from("Git bundle fixture");
  const provenance = { schemaVersion: 1 as const, workspaceId: randomUUID(), targetId: randomUUID(),
    targetRevisionId: randomUUID(), graphRevisionId: randomUUID(), bindingId: randomUUID(), connectionId: randomUUID(),
    repository: "owner/repo", ref: "main", baseCommit: "a".repeat(40), authorizationContextHash: "b".repeat(64) };
  const source = { bundle, baseCommit: provenance.baseCommit, contentHash: createHash("sha256").update(bundle).digest("hex"), provenance };
  const controller = new AbortController();
  const putFile = vi.fn(async (input: { body: Buffer; companyId: string }) => {
    const sha256 = createHash("sha256").update(input.body).digest("hex");
    return { provider: "local_disk" as const, objectKey: `${input.companyId}/verrail/run-artifacts/sha256/${sha256}`,
      contentType: "application/octet-stream", byteSize: input.body.length, sha256, originalFilename: null };
  });
  const ids = new Map<string, string>();
  const resource = (key: string) => { if (!ids.has(key)) ids.set(key, randomUUID()); return ids.get(key)!; };
  const createArtifact = vi.fn(async (command: { idempotencyKey: string }) => ({ schemaVersion: 1 as const,
    resourceType: "artifact" as const, resourceId: resource(command.idempotencyKey), replayed: false }));
  const addArtifactRevision = vi.fn(async (command: { idempotencyKey: string }) => ({ schemaVersion: 1 as const,
    resourceType: "artifact_revision" as const, resourceId: resource(command.idempotencyKey), replayed: false }));
  const recheck = vi.fn().mockResolvedValue(undefined);
  return { options: { source, principalId: "operator", signal: controller.signal, recheck,
    storage: { putFile }, domainApi: { createArtifact, addArtifactRevision } },
    controller, putFile, createArtifact, addArtifactRevision, recheck };
}

it("registers bundle and immutable provenance through domain commands with stable retry keys", async () => {
  const f = fixture();
  const first = await registerRepositorySource(f.options);
  expect(first.source.contentHash).toBe(f.options.source.contentHash);
  const manifest = JSON.parse(f.putFile.mock.calls[1][0].body.toString());
  expect(manifest).toMatchObject({ ...f.options.source.provenance, source: { artifactId: first.source.artifactId } });
  expect(f.createArtifact).toHaveBeenNthCalledWith(1, expect.objectContaining({ principalType: "user", principalId: "operator",
    input: { targetId: f.options.source.provenance.targetId, kind: "code_change", title: "Repository source" } }));
  expect(await registerRepositorySource(f.options)).toEqual(first);
  expect(f.createArtifact.mock.calls[0][0].idempotencyKey).toBe(f.createArtifact.mock.calls[2][0].idempotencyKey);
});

it("rejects hash mismatch before any upload or command", async () => {
  const f = fixture(); f.options.source.contentHash = "0".repeat(64);
  await expect(registerRepositorySource(f.options)).rejects.toThrow("SOURCE_INVALID");
  expect(f.putFile).not.toHaveBeenCalled(); expect(f.createArtifact).not.toHaveBeenCalled();
});

it("rejects invalid upload receipts before registering domain facts", async () => {
  const f = fixture();
  f.putFile.mockResolvedValue({ provider: "local_disk", objectKey: "foreign/key", contentType: "application/octet-stream",
    byteSize: 1, sha256: f.options.source.contentHash, originalFilename: null });
  await expect(registerRepositorySource(f.options)).rejects.toThrow("UPLOAD_RECEIPT_INVALID");
  expect(f.createArtifact).not.toHaveBeenCalled();
});

it("does not register after cancellation during upload", async () => {
  const f = fixture(); const upload = f.putFile.getMockImplementation()!;
  f.putFile.mockImplementation(async input => { const result = await upload(input); f.controller.abort(); return result; });
  await expect(registerRepositorySource(f.options)).rejects.toThrow();
  expect(f.createArtifact).not.toHaveBeenCalled();
});

it("stops on changed authorization between artifact creation and revision registration", async () => {
  const f = fixture();
  f.recheck.mockImplementation(async () => { if (f.createArtifact.mock.calls.length) throw new Error("revoked"); });
  await expect(registerRepositorySource(f.options)).rejects.toThrow("revoked");
  expect(f.createArtifact).toHaveBeenCalledTimes(1); expect(f.addArtifactRevision).not.toHaveBeenCalled();
});

it("does not retry an ambiguous domain response in the same invocation", async () => {
  const f = fixture(); f.addArtifactRevision.mockRejectedValue(new Error("response lost"));
  await expect(registerRepositorySource(f.options)).rejects.toThrow("response lost");
  expect(f.addArtifactRevision).toHaveBeenCalledTimes(1); expect(f.putFile).toHaveBeenCalledTimes(1);
});

it("rejects extra credential fields in persisted provenance", async () => {
  const f = fixture(); Object.assign(f.options.source.provenance, { authorization: "Bearer secret" });
  await expect(registerRepositorySource(f.options)).rejects.toThrow();
  expect(f.putFile).not.toHaveBeenCalled();
});
