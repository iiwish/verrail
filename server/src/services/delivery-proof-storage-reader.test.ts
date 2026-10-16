import { mkdtemp, mkdir, writeFile, rm, symlink, link, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createDeliveryProofStorageReader, readExecutionProofObject } from "./delivery-proof-storage-reader.js";

const workspace = "11111111-1111-4111-8111-111111111111";
const foreign = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];
const hash = (body: Buffer) => createHash("sha256").update(body).digest("hex");
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(namespace = "repository-execution-observations") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "verrail-proof-reader-"))); roots.push(root);
  const body = Buffer.from("private synthetic fixture"), digest = hash(body);
  const key = `${workspace}/verrail/${namespace}/sha256/${digest}`, filename = path.join(root, key);
  await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, body);
  return { root, body, key, filename, reader: createDeliveryProofStorageReader(root, workspace),
    ref: { contentHash: digest, contentRef: `storage:${key}`, bytes: body.length } };
}
it.each(["run-artifacts", "repository-execution-observations", "repository-execution-logs"])("reads only exact immutable %s bytes", async namespace => {
  const f = await fixture(namespace), object = await f.reader.getObject(workspace, f.key);
  const chunks = []; for await (const chunk of object.stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks)).toEqual(f.body); expect(object.contentLength).toBe(f.body.length);
  expect(Object.keys(f.reader)).toEqual(["getObject"]);
});
it.each(["workspace", "namespace", "traversal", "backslash", "range", "hash", "symlink file", "symlink parent", "hardlink", "oversize"])("rejects %s without returning private bytes", async failure => {
  const f = await fixture(); let key = f.key;
  if (failure === "namespace") key = key.replace("repository-execution-observations", "secrets");
  if (failure === "traversal") key = `${workspace}/../${key}`;
  if (failure === "backslash") key = key.replaceAll("/", "\\");
  if (failure === "hash") await writeFile(f.filename, "substituted");
  if (failure === "symlink file") {
    await rm(f.filename); const outside = path.join(f.root, "outside"); await writeFile(outside, f.body); await symlink(outside, f.filename);
  }
  if (failure === "symlink parent") {
    await rm(path.dirname(f.filename), { recursive: true }); const outside = path.join(f.root, "outside");
    await mkdir(outside); await writeFile(path.join(outside, f.ref.contentHash), f.body); await symlink(outside, path.dirname(f.filename));
  }
  if (failure === "hardlink") await link(f.filename, path.join(f.root, "other-link"));
  if (failure === "oversize") await writeFile(f.filename, Buffer.alloc(65537));
  await expect(f.reader.getObject(failure === "workspace" ? foreign : workspace, key,
    failure === "range" ? { range: { start: 0, end: 0 } } : undefined)).rejects.toThrow();
});
it("rejects a symlink configured root and noncanonical roots", async () => {
  const f = await fixture(); const alias = `${f.root}-alias`; roots.push(alias); await symlink(f.root, alias);
  await expect(createDeliveryProofStorageReader(alias, workspace).getObject(workspace, f.key)).rejects.toThrow();
  expect(() => createDeliveryProofStorageReader(`${f.root}/../`, workspace)).toThrow();
});
it("bounds pending provider reads and destroys streams delivered after timeout", async () => {
  const controller = new AbortController(); vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  const f = await fixture(); let resolve!: (value: { stream: Readable }) => void;
  const getObject = vi.fn(() => new Promise<{ stream: Readable }>(done => { resolve = done; }));
  const reading = readExecutionProofObject({ getObject }, workspace, f.ref, "repository-execution-observations");
  const rejected = expect(reading).rejects.toThrow();
  controller.abort(); await rejected;
  const stream = Readable.from([f.body]);
  resolve({ stream });
  await Promise.resolve();
  expect(stream.destroyed).toBe(true);
});
