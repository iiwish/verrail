import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("control-plane image loads its frozen runtime without embedded databases", {
  skip: !process.env.VERRAIL_TEST_CONTROL_IMAGE,
}, () => {
  const image = process.env.VERRAIL_TEST_CONTROL_IMAGE;
  const run = (args) => spawnSync("docker", ["run", "--rm", "--network", "none", "--read-only",
    "--platform", "linux/amd64", "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777",
    "--tmpfs", "/var/lib/verrail:rw,nosuid,nodev,uid=1000,gid=1000,mode=700", ...args], {
    encoding: "utf8", timeout: 60_000,
  });
  const uid = run(["--entrypoint", "id", image, "-u"]);
  assert.equal(uid.status, 0, uid.stderr);
  assert.equal(uid.stdout.trim(), "1000");
  const missing = run([image]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr.trim(), "Invalid runtime secret configuration");
  const imports = run(["--entrypoint", "node", image, "--import", "./server/node_modules/tsx/dist/loader.mjs",
    "--input-type=module", "-e", `
      const app = await import('./server/dist/app.js');
      if (typeof app.createApp !== 'function') throw new Error('Missing application export');
      const db = await import('./packages/db/dist/index.js');
      if (typeof db.applyMacoTestMigrations !== 'function') throw new Error('Missing migration export');
      const { access } = await import('node:fs/promises');
      await access('./ui/dist/index.html');
      console.log('Runtime imports ready');
    `]);
  assert.equal(imports.status, 0, imports.stderr);
  assert.match(imports.stdout, /Runtime imports ready/);
  const scan = run(["--entrypoint", "node", image, "--input-type=module", "-e", `
    const { readdir } = await import('node:fs/promises');
    async function scan(dir) {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        const name = dir + '/' + item.name;
        if (item.isDirectory()) await scan(name);
        if (item.isFile() && ['postgres', 'postgres.wasm', 'pglite.wasm', 'initdb', 'pg_ctl', 'codex'].includes(item.name)) {
          throw new Error('Forbidden runtime binary');
        }
      }
    }
    await scan('/app');
  `]);
  assert.equal(scan.status, 0, scan.stderr);
});
