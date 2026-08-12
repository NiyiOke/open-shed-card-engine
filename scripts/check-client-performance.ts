import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import {
  auditClientPerformance,
  parseVinextClientAssetManifest,
} from "../lib/build/client-performance-budget";

const projectRoot = process.cwd();
const clientRoot = resolve(projectRoot, "dist/client");
const manifestPath = resolve(projectRoot, "dist/server/vinext-client-assets.js");
const manifest = parseVinextClientAssetManifest(
  await readFile(manifestPath, "utf8"),
);
const assetBytes: Record<string, number> = {};

for (const file of await walk(clientRoot)) {
  if (!/\.(?:css|js)$/u.test(file)) continue;
  assetBytes[relative(clientRoot, file).split(sep).join("/")] = (await stat(file)).size;
}

const report = auditClientPerformance(manifest, assetBytes);
const kilobytes = (bytes: number) => `${(bytes / 1_000).toFixed(1)} KB`;

process.stdout.write(
  [
    `Initial JavaScript: ${kilobytes(report.initialJavaScriptBytes)}`,
    `Largest initial chunk: ${kilobytes(report.largestInitialChunkBytes)}`,
    `Lazy LiveKit: ${kilobytes(report.liveKitChunkBytes)}`,
    `Total client JavaScript: ${kilobytes(report.totalJavaScriptBytes)}`,
    `Total client CSS: ${kilobytes(report.totalCssBytes)}`,
  ].join("\n") + "\n",
);

if (report.errors.length) {
  for (const error of report.errors) process.stderr.write(`- ${error}\n`);
  process.exitCode = 1;
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
