import { execFileSync } from "node:child_process";
import path from "node:path";

export function selectVitestProcessSessions(testRoot, processList) {
  if (!path.isAbsolute(testRoot) || !/^pcvt-\d+-\d+-[A-Za-z0-9]+$/.test(path.basename(testRoot))) {
    throw new Error("An isolated pcvt test root is required for process cleanup");
  }
  const prefix = `${testRoot}/t/paperclip-`;
  return processList.split("\n").flatMap((line) => {
    const row = line.trim().match(/^(\d+)\s+((?:\S*\/)?node)\s+(\S+)$/);
    if (!row || path.normalize(row[3]) !== row[3] || !row[3].startsWith(prefix)
      || !/\/\.paperclip-runtime\/(?:acp_engine|acpx|claude_local|codex_local)\/process-sessions\/paperclip-process-session-remote\.mjs$/.test(row[3])) return [];
    return [Number(row[1])];
  });
}

export function cleanupVitestProcessSessions(testRoot) {
  if (process.platform === "win32") return [];
  const args = ["-u", String(process.getuid()), "-o", "pid=,args="];
  const candidates = selectVitestProcessSessions(testRoot, execFileSync("ps", args, { encoding: "utf8" }));
  const signaled = [];
  for (const pid of candidates) {
    try {
      // Recheck immediately before signaling so a recycled PID cannot widen cleanup.
      const current = execFileSync("ps", ["-p", String(pid), "-o", "pid=,args="], { encoding: "utf8" });
      if (!selectVitestProcessSessions(testRoot, current).includes(pid)) continue;
      process.kill(pid, "SIGTERM");
      signaled.push(pid);
    } catch (error) {
      if (error.code !== "ESRCH" && error.status !== 1) throw error;
    }
  }
  return signaled;
}
