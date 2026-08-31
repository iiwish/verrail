import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkUiBundleBudget, measureUiBundle } from "./check-ui-bundle-budget.mjs";

test("measureUiBundle reports largest and aggregate JavaScript sizes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "verrail-bundle-budget-"));
  try {
    await writeFile(path.join(directory, "entry.js"), "a".repeat(1_000));
    await writeFile(path.join(directory, "route.js"), "b".repeat(400));
    await writeFile(path.join(directory, "styles.css"), "c".repeat(2_000));

    const result = await measureUiBundle(directory);
    assert.equal(result.fileCount, 2);
    assert.equal(result.largest.fileName, "entry.js");
    assert.equal(result.largest.rawBytes, 1_000);
    assert.equal(result.total.rawBytes, 1_400);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checkUiBundleBudget rejects either entry or aggregate growth", async () => {
  const measurement = {
    fileCount: 2,
    largest: { fileName: "entry.js", rawBytes: 1_000, gzipBytes: 100 },
    total: { rawBytes: 1_400, gzipBytes: 180 },
  };

  assert.equal(checkUiBundleBudget(measurement, {
    largestRawBytes: 1_000,
    largestGzipBytes: 100,
    totalRawBytes: 1_400,
    totalGzipBytes: 180,
  }).length, 0);
  assert.deepEqual(
    checkUiBundleBudget(measurement, {
      largestRawBytes: 999,
      largestGzipBytes: 100,
      totalRawBytes: 1_399,
      totalGzipBytes: 180,
    }).map((failure) => failure.metric),
    ["largestRawBytes", "totalRawBytes"],
  );
});
