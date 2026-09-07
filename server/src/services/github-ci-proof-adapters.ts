import { crc32 } from "node:zlib";
import type { Readable } from "node:stream";
import * as yauzl from "yauzl";
import type { GitHubCiReadDependencies } from "./github-ci-proof-reader.js";

const MAX_ARCHIVE_BYTES = 10_000_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_REPORT_BYTES = 1_000_000;
const REPORT_FILE = "verrail-fixed-ci.json";
const transportError = () => new Error("GitHub CI transport failed");
const archiveError = () => new Error("GitHub CI archive rejected");

function safeId(value: string) { return /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)); }

function permittedPath(path: string, base: string) {
  if (!path.startsWith(base)) return false;
  const suffix = path.slice(base.length);
  const run = /^\/actions\/runs\/([1-9][0-9]*)\/attempts\/([1-9][0-9]*)$/.exec(suffix);
  if (run) return safeId(run[1]!) && safeId(run[2]!);
  const jobs = /^\/actions\/runs\/([1-9][0-9]*)\/attempts\/([1-9][0-9]*)\/jobs\?page=([1-9][0-9]?)&per_page=100$/.exec(suffix);
  if (jobs) return safeId(jobs[1]!) && safeId(jobs[2]!) && Number(jobs[3]) <= 20;
  const artifacts = /^\/actions\/runs\/([1-9][0-9]*)\/artifacts\?page=([1-9][0-9]?)&per_page=100$/.exec(suffix);
  if (artifacts) return safeId(artifacts[1]!) && Number(artifacts[2]) <= 20;
  const zip = /^\/actions\/artifacts\/([1-9][0-9]*)\/zip$/.exec(suffix);
  if (zip) return safeId(zip[1]!);
  return /^\/contents\/\.github\/(?:workflows\/verrail-candidate-verify\.yml|scripts\/verrail-candidate-proof\.mjs)\?ref=[a-f0-9]{40}$/.test(suffix);
}

function publicHost(host: string) {
  return host.length <= 253 && /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*\.[a-z]{2,}$/.test(host)
    && !/(?:^|\.)(?:localhost|local|internal|test-invalid)$/.test(host);
}

// The reader supplies tighter policy budgets. These hard caps also protect the
// transport if it is accidentally called outside the reader's consumption loop.
function boundedResponse(response: Response, signal: AbortSignal, maxBytes: number) {
  const cancel = () => { void response.body?.cancel().catch(() => {}); };
  const declared = response.headers.get("content-length");
  if (signal.aborted || response.redirected || (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes))) {
    cancel(); throw transportError();
  }
  if (response.status !== 200 || !response.body) { cancel(); return response; }
  const source = response.body.getReader(); let size = 0; let finished = false;
  let output: ReadableStreamDefaultController<Uint8Array>;
  const cleanup = () => { finished = true; signal.removeEventListener("abort", abort); void source.cancel().catch(() => {}); };
  const abort = () => { if (!finished) { cleanup(); output.error(transportError()); } };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { output = controller; signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); },
    async pull(controller) {
      try {
        const chunk = await source.read(); if (finished) return;
        if (chunk.done) { cleanup(); controller.close(); return; }
        size += chunk.value.byteLength; if (size > maxBytes) throw transportError();
        controller.enqueue(chunk.value);
      } catch { if (!finished) { cleanup(); controller.error(transportError()); } }
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { status: response.status, headers: response.headers });
}

const decodeReportArchive: GitHubCiReadDependencies["decodeReportArchive"] = async (bytes, limits) => {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_ARCHIVE_BYTES || limits.fileName !== REPORT_FILE
    || limits.maxEntries !== 1 || !Number.isSafeInteger(limits.maxUncompressedBytes)
    || limits.maxUncompressedBytes < 1 || limits.maxUncompressedBytes > MAX_REPORT_BYTES || limits.signal.aborted) throw archiveError();

  return new Promise((resolve, reject) => {
    let zip: yauzl.ZipFile | undefined; let stream: Readable | undefined; let finished = false;
    const entries: Array<{ name: string; bytes: Uint8Array }> = [];
    const cleanup = () => { limits.signal.removeEventListener("abort", fail); stream?.destroy(); zip?.close(); };
    const fail = () => { if (!finished) { finished = true; cleanup(); reject(archiveError()); } };
    limits.signal.addEventListener("abort", fail, { once: true });
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, decodeStrings: true }, (error, opened) => {
      if (error || !opened) { fail(); return; }
      zip = opened; zip.on("error", fail);
      if (finished || limits.signal.aborted) { zip.close(); fail(); return; }
      if (zip.entryCount !== 1 || zip.comment !== "") { fail(); return; }
      zip.on("end", () => {
        if (finished) return;
        if (entries.length !== 1) { fail(); return; }
        finished = true; cleanup(); resolve(entries);
      });
      zip.on("entry", (entry: yauzl.Entry) => {
        if (finished) return;
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (entries.length > 0 || entry.fileName !== REPORT_FILE || (mode !== 0 && mode !== 0o100000)
          || (entry.externalFileAttributes & 0x10) !== 0 || (entry.generalPurposeBitFlag & ~0x080e) !== 0
          || ![0, 8].includes(entry.compressionMethod) || entry.uncompressedSize > limits.maxUncompressedBytes
          || entry.compressedSize > bytes.byteLength || entry.uncompressedSize < 1
          || entry.relativeOffsetOfLocalHeader !== 0 || entry.extraFields.some(field => field.id === 1)) { fail(); return; }
        // yauzl intentionally trusts the central directory. This fixed report
        // contract also rejects conflicting redundant local-header metadata.
        zip!.readLocalFileHeader(entry, (headerError, local) => {
          if (finished) return;
          if (headerError || !local || !local.fileName.equals(Buffer.from(REPORT_FILE))
            || local.generalPurposeBitFlag !== entry.generalPurposeBitFlag || local.compressionMethod !== entry.compressionMethod
            || ((entry.generalPurposeBitFlag & 8) === 0 && (local.crc32 !== entry.crc32
              || local.compressedSize !== entry.compressedSize || local.uncompressedSize !== entry.uncompressedSize))) { fail(); return; }
          // Restrict this tiny report to ordinary ZIP, without ZIP64, archive
          // comments, prepended payloads or hidden extra directory records.
          // All offsets and variable lengths come from yauzl, not a second parser.
          const descriptorBytes = bytes.byteLength - (local.fileDataStart + entry.compressedSize
            + 46 + entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength + 22);
          if ((entry.generalPurposeBitFlag & 8) !== 0 ? ![12, 16].includes(descriptorBytes) : descriptorBytes !== 0) { fail(); return; }
          zip!.openReadStream(entry, (streamError, openedStream) => {
            if (streamError || !openedStream) { fail(); return; }
            stream = openedStream; stream.on("error", fail);
            if (finished || limits.signal.aborted) { stream.destroy(); fail(); return; }
            let length = 0; let checksum = 0; const chunks: Buffer[] = [];
            stream.on("data", (chunk: Buffer) => {
              if (finished) return;
              length += chunk.length;
              if (length > limits.maxUncompressedBytes || length > entry.uncompressedSize) { fail(); return; }
              checksum = crc32(chunk, checksum); chunks.push(chunk);
            });
            stream.on("end", () => {
              if (finished) return;
              if (length !== entry.uncompressedSize || checksum !== entry.crc32) { fail(); return; }
              entries.push({ name: REPORT_FILE, bytes: Buffer.concat(chunks, length) }); zip!.readEntry();
            });
          });
        });
      });
      zip.readEntry();
    });
  });
};

export function createGitHubCiReadDependencies(options: {
  repository: string;
  authorization: string;
  artifactDownloadHosts: readonly string[];
  fetch?: typeof globalThis.fetch;
}): GitHubCiReadDependencies {
  const { repository, authorization } = options;
  const hosts = new Set(options.artifactDownloadHosts);
  if (repository.length > 256 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    || repository.split("/").some(part => part === "." || part === "..")
    || !/^(?:Bearer|token) [A-Za-z0-9._~-]+$/.test(authorization) || authorization.length > 8192
    || hosts.size === 0 || hosts.size > 20 || [...hosts].some(host => !publicHost(host))) throw transportError();
  const fetch = options.fetch ?? globalThis.fetch;
  const base = `/repos/${repository}`;
  return {
    async get(path, init) {
      try {
        if (init.signal.aborted || !permittedPath(path, base)) throw transportError();
        const response = await fetch(`https://api.github.com${path}`, {
          method: "GET", redirect: "manual", signal: init.signal, credentials: "omit",
          headers: { authorization, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
        });
        return boundedResponse(response, init.signal, path.endsWith("/zip") ? MAX_ARCHIVE_BYTES : MAX_RESPONSE_BYTES);
      } catch { throw transportError(); }
    },
    async publicGet(raw, init) {
      try {
        const url = new URL(raw);
        if (init.signal.aborted || raw.length > 16_384 || url.protocol !== "https:" || url.username || url.password || url.port || url.hash
          || !hosts.has(url.hostname)) throw transportError();
        const response = await fetch(url.toString(), { method: "GET", redirect: "manual", signal: init.signal, credentials: "omit", headers: {} });
        return boundedResponse(response, init.signal, MAX_ARCHIVE_BYTES);
      } catch { throw transportError(); }
    },
    decodeReportArchive,
  };
}
