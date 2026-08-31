import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brandRoot = path.join(repoRoot, "ui/public/brand/verrail");
const manifestPath = path.join(brandRoot, "asset-manifest.json");
const forbiddenSvgFeatures = /<(?:linearGradient|radialGradient|filter|image)\b/i;
const requiredAssets = new Map([
  ["mark-mono.svg", [64, 64]],
  ["mark-dark.svg", [64, 64]],
  ["mark-light.svg", [64, 64]],
  ["wordmark-dark.svg", [248, 64]],
  ["wordmark-light.svg", [248, 64]],
  ["lockup-dark.svg", [328, 64]],
  ["lockup-light.svg", [328, 64]],
  ["favicon.svg", [64, 64]],
  ["app-icon.svg", [512, 512]],
  ["app-icon-maskable.svg", [512, 512]],
  ["icon-16.png", [16, 16]],
  ["icon-32.png", [32, 32]],
  ["icon-48.png", [48, 48]],
  ["icon-180.png", [180, 180]],
  ["icon-192.png", [192, 192]],
  ["icon-512.png", [512, 512]],
  ["icon-maskable-512.png", [512, 512]],
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pngDimensions(bytes) {
  const signature = bytes.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") {
    throw new Error("Invalid PNG signature");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function svgDimensions(bytes) {
  const source = bytes.toString("utf8");
  if (forbiddenSvgFeatures.test(source)) {
    throw new Error("SVG contains a gradient, filter, or embedded raster image");
  }
  const viewBox = source.match(/viewBox="([^"]+)"/)?.[1]?.trim().split(/\s+/).map(Number);
  if (!viewBox || viewBox.length !== 4 || viewBox.some((value) => !Number.isFinite(value))) {
    throw new Error("SVG must declare a numeric viewBox");
  }
  return { width: viewBox[2], height: viewBox[3] };
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const errors = [];

if (manifest.brand !== "Verrail" || manifest.version !== 1) {
  errors.push("Manifest must identify Verrail and schema version 1");
}

const manifestFiles = (manifest.assets ?? []).map((asset) => asset.file);
for (const file of requiredAssets.keys()) {
  if (!manifestFiles.includes(file)) errors.push(`${file}: missing from manifest`);
}
for (const file of manifestFiles) {
  if (!requiredAssets.has(file)) errors.push(`${file}: unexpected manifest entry`);
}
if (new Set(manifestFiles).size !== manifestFiles.length) {
  errors.push("Manifest contains duplicate asset entries");
}

for (const asset of manifest.assets ?? []) {
  const assetPath = path.join(brandRoot, asset.file);
  let bytes;
  try {
    bytes = await readFile(assetPath);
  } catch (error) {
    errors.push(`${asset.file}: missing (${error.message})`);
    continue;
  }

  const actualHash = sha256(bytes);
  if (actualHash !== asset.sha256) {
    errors.push(`${asset.file}: SHA-256 mismatch`);
  }

  try {
    const dimensions = asset.file.endsWith(".png") ? pngDimensions(bytes) : svgDimensions(bytes);
    const requiredDimensions = requiredAssets.get(asset.file);
    if (
      dimensions.width !== asset.width
      || dimensions.height !== asset.height
      || (requiredDimensions
        && (dimensions.width !== requiredDimensions[0] || dimensions.height !== requiredDimensions[1]))
    ) {
      errors.push(
        `${asset.file}: expected ${asset.width}x${asset.height}, got ${dimensions.width}x${dimensions.height}`,
      );
    }
  } catch (error) {
    errors.push(`${asset.file}: ${error.message}`);
  }
}

if (errors.length > 0) {
  console.error(`Verrail brand asset validation failed:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}

console.log(`Validated ${manifest.assets.length} Verrail brand assets.`);
