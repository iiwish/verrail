import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubCiReadDependencies } from "./github-ci-proof-adapters.js";

const fileName = "verrail-fixed-ci.json";
const path = "/repos/acme/repo/actions/runs/12/attempts/2";
const init = () => ({ method: "GET" as const, redirect: "manual" as const, signal: new AbortController().signal });
const options = { repository: "acme/repo", authorization: "Bearer test-only-secret", artifactDownloadHosts: ["artifacts.example.com"] };

// Real local/central directory records let adversarial metadata reach the real parser.
function archive(entries: Array<{ name?: string; body?: Buffer; method?: number; flags?: number; mode?: number; dos?: number; declaredSize?: number; compressed?: Buffer; crc?: number; descriptor?: boolean }> = [{}]) {
  const local: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name ?? fileName); const body = entry.body ?? Buffer.from('{"ok":true}');
    const method = entry.method ?? 8; const data = entry.compressed ?? (method === 8 ? deflateRawSync(body) : body);
    const checksum = entry.crc ?? crc32(body); const size = entry.declaredSize ?? body.length;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    const flags = (entry.flags ?? 0) | (entry.descriptor ? 8 : 0);
    header.writeUInt16LE(flags, 6); header.writeUInt16LE(method, 8); header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(size, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const descriptor = Buffer.alloc(entry.descriptor ? 16 : 0);
    if (entry.descriptor) {
      header.fill(0, 14, 26); descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(data.length, 8); descriptor.writeUInt32LE(size, 12); local.push(descriptor);
    }
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(flags, 8); directory.writeUInt16LE(method, 10); directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(size, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE((((entry.mode ?? 0o100644) << 16) | (entry.dos ?? 0)) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    central.push(directory, name); offset += header.length + name.length + data.length + descriptor.length;
  }
  const tail = Buffer.alloc(22); tail.writeUInt32LE(0x06054b50); tail.writeUInt16LE(entries.length, 8); tail.writeUInt16LE(entries.length, 10);
  tail.writeUInt32LE(Buffer.concat(central).length, 12); tail.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, tail]);
}

afterEach(() => vi.unstubAllGlobals());

describe("GitHub CI bounded transports", () => {
  it("defaults to native fetch with confined auth and caller signal", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fetch);
    const deps = createGitHubCiReadDependencies(options); const request = init();
    await deps.get(path, { ...request, headers: { cookie: "injected" }, method: "POST", redirect: "follow" } as never);
    expect(fetch).toHaveBeenCalledWith(`https://api.github.com${path}`, expect.objectContaining({ method: "GET", redirect: "manual", credentials: "omit", signal: request.signal }));
    const headers = new Headers(fetch.mock.calls[0]![1].headers);
    expect(headers.get("authorization")).toBe(options.authorization); expect(headers.has("cookie")).toBe(false);
  });

  it.each([
    path, `${path}/jobs?page=1&per_page=100`, "/repos/acme/repo/actions/runs/12/artifacts?page=20&per_page=100",
    "/repos/acme/repo/actions/artifacts/34/zip", `/repos/acme/repo/contents/.github/workflows/verrail-candidate-verify.yml?ref=${"a".repeat(40)}`,
    `/repos/acme/repo/contents/.github/scripts/verrail-candidate-proof.mjs?ref=${"a".repeat(40)}`,
  ])("permits only the reader endpoint family: %s", async endpoint => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    await createGitHubCiReadDependencies({ ...options, fetch }).get(endpoint, init()); expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    "https://evil.example/token", "//evil.example/token", "/repos/acme/other/actions/runs/12/attempts/2", `${path}?token=secret`,
    "/repos/acme/repo/../other/actions/runs/12/attempts/2", "/repos/acme/repo/%2e%2e/other", `${path}#hash`,
    `${path}/jobs?page=21&per_page=100`, `${path}/jobs?page=1&per_page=100&page=2`, "/repos/acme/repo/issues",
    "/repos/acme/repo/actions/runs/0/attempts/1", "/repos/acme/repo/actions/runs/9007199254740992/attempts/1",
    `/repos/acme/repo/contents/.env?ref=${"a".repeat(40)}`,
  ])("rejects auth path escapes before fetch: %s", async endpoint => {
    const fetch = vi.fn(); await expect(createGitHubCiReadDependencies({ ...options, fetch }).get(endpoint, init())).rejects.toThrow("GitHub CI transport failed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("isolates unsigned downloads even when caller injects headers and credentials", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("zip")); const deps = createGitHubCiReadDependencies({ ...options, fetch });
    await deps.publicGet("https://artifacts.example.com/report?sig=test", { ...init(), credentials: "include", headers: { authorization: options.authorization, cookie: "test" } } as never);
    const passed = fetch.mock.calls[0]![1]; expect(passed.credentials).toBe("omit"); expect(passed.redirect).toBe("manual");
    expect(new Headers(passed.headers).has("authorization")).toBe(false); expect(new Headers(passed.headers).has("cookie")).toBe(false);
  });

  it.each(["http://artifacts.example.com/x", "https://artifacts.example.com.evil.test/x", "https://user:pass@artifacts.example.com/x", "https://artifacts.example.com:8443/x", "https://artifacts.example.com/x#secret", "https://127.0.0.1/x", "https://api.github.com/x"])("rejects untrusted downloads: %s", async url => {
    const fetch = vi.fn(); await expect(createGitHubCiReadDependencies({ ...options, fetch }).publicGet(url, { ...init(), credentials: "omit" })).rejects.toThrow("GitHub CI transport failed"); expect(fetch).not.toHaveBeenCalled();
  });

  it("never follows redirects and cancels unused redirect bodies", async () => {
    const cancel = vi.fn(); const fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 302, headers: { location: "https://artifacts.example.com/signed" } }));
    const response = await createGitHubCiReadDependencies({ ...options, fetch }).get("/repos/acme/repo/actions/artifacts/34/zip", init());
    expect(response.status).toBe(302); expect(cancel).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce();
  });

  it("sanitizes provider failures, including causes and already-followed redirects", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("test-only-secret https://signed.example")); const deps = createGitHubCiReadDependencies({ ...options, fetch });
    const error = await deps.get(path, init()).catch(e => e); expect(error.message).toBe("GitHub CI transport failed"); expect(error.cause).toBeUndefined();
    const response = new Response("{}"); Object.defineProperty(response, "redirected", { value: true }); fetch.mockResolvedValue(response);
    await expect(deps.get(path, init())).rejects.toThrow("GitHub CI transport failed");
  });

  it("rejects pre-abort without network and aborts a stalled response stream", async () => {
    const fetch = vi.fn(); const controller = new AbortController(); controller.abort(new Error("private"));
    const deps = createGitHubCiReadDependencies({ ...options, fetch }); await expect(deps.get(path, { ...init(), signal: controller.signal })).rejects.toThrow("GitHub CI transport failed"); expect(fetch).not.toHaveBeenCalled();
    const cancel = vi.fn(); fetch.mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const active = new AbortController(); const response = await deps.get(path, { ...init(), signal: active.signal }); const pending = response.body!.getReader().read(); active.abort();
    await expect(pending).rejects.toThrow("GitHub CI transport failed"); expect(cancel).toHaveBeenCalled();
  });

  it("bounds streamed responses without relying on content-length", async () => {
    const cancel = vi.fn(); const fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(2_000_001)); }, cancel,
    })));
    const response = await createGitHubCiReadDependencies({ ...options, fetch }).get(path, init());
    await expect(response.arrayBuffer()).rejects.toThrow("GitHub CI transport failed"); expect(cancel).toHaveBeenCalled();
  });

  it.each(["-1", "NaN", "2000001"])("rejects invalid advertised response size %s", async size => {
    const cancel = vi.fn(); const fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { "content-length": size } }));
    await expect(createGitHubCiReadDependencies({ ...options, fetch }).get(path, init())).rejects.toThrow("GitHub CI transport failed"); expect(cancel).toHaveBeenCalled();
  });

  it("sanitizes response body errors and cancels abandoned consumer streams", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.error(new Error("private response body")); } })));
    const deps = createGitHubCiReadDependencies({ ...options, fetch });
    await expect((await deps.get(path, init())).text()).rejects.toThrow(/^GitHub CI transport failed$/);
    const cancel = vi.fn(); fetch.mockResolvedValue(new Response(new ReadableStream({ cancel })));
    await (await deps.get(path, init())).body!.cancel(); expect(cancel).toHaveBeenCalled();
  });

  it("snapshots server-owned host policy and rejects invalid factory config", async () => {
    const artifactDownloadHosts = [...options.artifactDownloadHosts]; const fetch = vi.fn();
    const deps = createGitHubCiReadDependencies({ ...options, artifactDownloadHosts, fetch }); artifactDownloadHosts.push("evil.example.com");
    await expect(deps.publicGet("https://evil.example.com/x", { ...init(), credentials: "omit" })).rejects.toThrow("GitHub CI transport failed");
    for (const invalid of [{ repository: "acme/.." }, { authorization: "Bearer x\r\nCookie: secret" }, { artifactDownloadHosts: ["localhost"] }]) {
      expect(() => createGitHubCiReadDependencies({ ...options, ...invalid })).toThrow(/^GitHub CI transport failed$/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("real yauzl archive validation", () => {
  const deps = createGitHubCiReadDependencies(options);
  const decode = (bytes: Uint8Array, maxUncompressedBytes = 1024, signal = new AbortController().signal) => deps.decodeReportArchive(bytes, { fileName, maxEntries: 1, maxUncompressedBytes, signal });
  it.each([0, 8])("decodes a single regular JSON report with compression %i", async method => {
    const entries = await decode(archive([{ method }])); expect(entries).toHaveLength(1); expect(entries[0]!.name).toBe(fileName); expect(Buffer.from(entries[0]!.bytes).toString()).toBe('{"ok":true}');
  });
  it("decodes ordinary deflate with a data descriptor", async () => {
    expect(await decode(archive([{ descriptor: true }]))).toHaveLength(1);
  });
  it.each(["../verrail-fixed-ci.json", "/verrail-fixed-ci.json", "dir/verrail-fixed-ci.json", "dir\\verrail-fixed-ci.json", "C:/verrail-fixed-ci.json", "verrail-fixed-ci.json/", "other.json"])("rejects nonexact entry path %s", async name => {
    await expect(decode(archive([{ name }]))).rejects.toThrow("GitHub CI archive rejected");
  });
  it.each([
    ["symlink", { mode: 0o120777 }], ["directory mode", { mode: 0o040755 }], ["DOS directory", { dos: 16 }],
    ["FIFO", { mode: 0o010644 }], ["encrypted", { flags: 1 }], ["strong encrypted", { flags: 64 }],
    ["unsupported compression", { method: 12 }], ["invalid CRC", { crc: 123 }],
    ["invalid deflate", { compressed: Buffer.from("not deflate") }], ["lying decompressed size", { body: Buffer.alloc(100_000, 65), declaredSize: 10 }],
    ["truncated deflate", { body: Buffer.alloc(100_000, 65), compressed: deflateRawSync(Buffer.alloc(100_000, 65)).subarray(0, 20) }],
  ] as const)("rejects %s using actual bytes", async (_name, entry) => {
    await expect(decode(archive([entry]))).rejects.toThrow("GitHub CI archive rejected");
  });
  it("rejects empty, duplicate, malformed and truncated archives", async () => {
    for (const bytes of [archive([]), archive([{}, {}]), Buffer.from("not zip"), archive().subarray(0, 50)]) await expect(decode(bytes)).rejects.toThrow("GitHub CI archive rejected");
  });
  it("rejects conflicting local-header metadata", async () => {
    for (const [offset, value] of [[6, 1], [8, 12], [14, 123], [22, 2]] as const) {
      const bytes = archive(); bytes.writeUInt16LE(value, offset); await expect(decode(bytes)).rejects.toThrow("GitHub CI archive rejected");
    }
    const nameMismatch = archive(); nameMismatch[30] = 120; await expect(decode(nameMismatch)).rejects.toThrow("GitHub CI archive rejected");
  });
  it("rejects a second central entry hidden by a lying entry count", async () => {
    const bytes = archive([{}, {}]); bytes.writeUInt16LE(1, bytes.length - 14); bytes.writeUInt16LE(1, bytes.length - 12);
    await expect(decode(bytes)).rejects.toThrow("GitHub CI archive rejected");
  });
  it("bounds compressed input and decompressed output", async () => {
    await expect(decode(Buffer.alloc(10_000_001))).rejects.toThrow("GitHub CI archive rejected");
    await expect(decode(archive([{ body: Buffer.alloc(1025, 65) }]))).rejects.toThrow("GitHub CI archive rejected");
    await expect(decode(archive(), 1_000_001)).rejects.toThrow("GitHub CI archive rejected");
  });
  it("supports cancellation before parsing and while inflating", async () => {
    const controller = new AbortController(); controller.abort(); await expect(decode(archive(), 1024, controller.signal)).rejects.toThrow("GitHub CI archive rejected");
    const active = new AbortController(); const pending = decode(archive([{ body: Buffer.alloc(1_000_000, 65) }]), 1_000_000, active.signal);
    setImmediate(() => active.abort()); await expect(pending).rejects.toThrow("GitHub CI archive rejected");
  });
});
