import { build } from "esbuild";

await build({
  entryPoints: ["server/src/execution/gateway-main.ts"],
  outfile: "dist/execution-gateway/gateway.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  sourcemap: false,
  logLevel: "info",
});
