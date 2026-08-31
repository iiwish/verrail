#!/usr/bin/env node

import { gzipSync } from "node:zlib";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const UI_BUNDLE_BUDGET = Object.freeze({
  largestRawBytes: 7_750_000,
  largestGzipBytes: 2_150_000,
  totalRawBytes: 12_700_000,
  totalGzipBytes: 3_650_000,
});

export async function measureUiBundle(assetsDirectory) {
  const entries = (await readdir(assetsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length === 0) throw new Error(`No JavaScript bundles found in ${assetsDirectory}`);

  const files = await Promise.all(entries.map(async (entry) => {
    const bytes = await readFile(path.join(assetsDirectory, entry.name));
    return {
      fileName: entry.name,
      rawBytes: bytes.byteLength,
      gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
    };
  }));
  const largest = files.reduce((current, file) => file.rawBytes > current.rawBytes ? file : current);

  return {
    fileCount: files.length,
    largest,
    total: {
      rawBytes: files.reduce((sum, file) => sum + file.rawBytes, 0),
      gzipBytes: files.reduce((sum, file) => sum + file.gzipBytes, 0),
    },
  };
}

export function checkUiBundleBudget(measurement, budget = UI_BUNDLE_BUDGET) {
  const values = {
    largestRawBytes: measurement.largest.rawBytes,
    largestGzipBytes: measurement.largest.gzipBytes,
    totalRawBytes: measurement.total.rawBytes,
    totalGzipBytes: measurement.total.gzipBytes,
  };
  return Object.entries(budget)
    .filter(([metric, limit]) => values[metric] > limit)
    .map(([metric, limit]) => ({ metric, actual: values[metric], limit }));
}

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

async function main() {
  const assetsDirectory = path.resolve(process.argv[2] ?? "ui/dist/assets");
  const measurement = await measureUiBundle(assetsDirectory);
  const failures = checkUiBundleBudget(measurement);
  console.log(`UI bundle baseline: ${measurement.fileCount} JavaScript files`);
  console.log(
    `Largest: ${measurement.largest.fileName} ${formatMiB(measurement.largest.rawBytes)} raw / ${formatMiB(measurement.largest.gzipBytes)} gzip`,
  );
  console.log(
    `Total: ${formatMiB(measurement.total.rawBytes)} raw / ${formatMiB(measurement.total.gzipBytes)} gzip`,
  );
  if (failures.length === 0) {
    console.log("UI bundle budget: PASS");
    return;
  }
  for (const failure of failures) {
    console.error(`${failure.metric}: ${failure.actual} bytes exceeds ${failure.limit} bytes`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
