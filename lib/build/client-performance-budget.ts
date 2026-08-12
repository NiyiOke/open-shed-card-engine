export type VinextClientAssetManifest = Readonly<{
  appBootstrapPreinitModules: ReadonlyArray<string>;
  dynamicPreloads: Readonly<Record<string, ReadonlyArray<string>>>;
  lazyChunks: ReadonlyArray<string>;
}>;

export type ClientPerformanceBudget = Readonly<{
  initialJavaScriptBytes: number;
  largestInitialChunkBytes: number;
  liveKitChunkBytes: number;
  totalJavaScriptBytes: number;
  totalCssBytes: number;
}>;

export type ClientPerformanceReport = Readonly<{
  initialAssets: ReadonlyArray<string>;
  liveKitAssets: ReadonlyArray<string>;
  initialJavaScriptBytes: number;
  largestInitialChunkBytes: number;
  liveKitChunkBytes: number;
  totalJavaScriptBytes: number;
  totalCssBytes: number;
  errors: ReadonlyArray<string>;
}>;

export const CLIENT_PERFORMANCE_BUDGET = Object.freeze({
  // Current V1.6 baseline is about 559 KB before transport compression.
  initialJavaScriptBytes: 610_000,
  // Prevent a single eager application/framework chunk from dominating parse.
  largestInitialChunkBytes: 220_000,
  // LiveKit is intentionally large, but it must remain a bounded lazy chunk.
  liveKitChunkBytes: 600_000,
  // Includes every lazy client chunk, not only the initial route.
  totalJavaScriptBytes: 1_200_000,
  totalCssBytes: 96_000,
} satisfies ClientPerformanceBudget);

const BROWSER_ENTRY = "virtual:vinext-app-browser-entry";
const GAME_SHELL_ENTRY = "app/components/GameShell.tsx";
const LIVEKIT_ENTRY = "node_modules/livekit-client/dist/livekit-client.esm.mjs";

export function parseVinextClientAssetManifest(
  source: string,
): VinextClientAssetManifest {
  const match = /^\s*export default (\{[\s\S]*\});?\s*$/u.exec(source);
  if (!match) throw new Error("CLIENT_ASSET_MANIFEST_FORMAT");
  let value: unknown;
  try {
    value = JSON.parse(match[1]);
  } catch {
    throw new Error("CLIENT_ASSET_MANIFEST_JSON");
  }
  if (!isRecord(value)) throw new Error("CLIENT_ASSET_MANIFEST_SHAPE");
  const bootstrap = readStringArray(value.appBootstrapPreinitModules);
  const lazyChunks = readStringArray(value.lazyChunks);
  if (!bootstrap || !lazyChunks || !isRecord(value.dynamicPreloads)) {
    throw new Error("CLIENT_ASSET_MANIFEST_SHAPE");
  }
  const dynamicPreloads: Record<string, ReadonlyArray<string>> = {};
  for (const [key, entry] of Object.entries(value.dynamicPreloads)) {
    const assets = readStringArray(entry);
    if (!assets) throw new Error("CLIENT_ASSET_MANIFEST_SHAPE");
    dynamicPreloads[key] = Object.freeze([...assets]);
  }
  return Object.freeze({
    appBootstrapPreinitModules: Object.freeze([...bootstrap]),
    dynamicPreloads: Object.freeze(dynamicPreloads),
    lazyChunks: Object.freeze([...lazyChunks]),
  });
}

export function auditClientPerformance(
  manifest: VinextClientAssetManifest,
  assetBytes: Readonly<Record<string, number>>,
  budget: ClientPerformanceBudget = CLIENT_PERFORMANCE_BUDGET,
): ClientPerformanceReport {
  const errors: string[] = [];
  const initialAssets = uniqueAssets([
    ...manifest.appBootstrapPreinitModules,
    ...readEntryAssets(manifest, BROWSER_ENTRY, errors),
    ...readEntryAssets(manifest, GAME_SHELL_ENTRY, errors),
  ]).filter(isJavaScriptAsset);
  const liveKitAssets = uniqueAssets(
    readEntryAssets(manifest, LIVEKIT_ENTRY, errors),
  ).filter(isJavaScriptAsset);
  if (liveKitAssets.length === 0) {
    errors.push("LiveKit has no dedicated lazy client chunk.");
  }

  const normalizedSizes: Record<string, number> = {};
  for (const [asset, bytes] of Object.entries(assetBytes)) {
    const normalized = normalizeAssetPath(asset);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      errors.push(`Asset ${normalized} has an invalid byte size.`);
      continue;
    }
    normalizedSizes[normalized] = bytes;
  }
  const sizeOf = (asset: string): number => {
    const normalized = normalizeAssetPath(asset);
    const size = normalizedSizes[normalized];
    if (size === undefined) {
      errors.push(`Built client asset is missing: ${normalized}.`);
      return 0;
    }
    return size;
  };

  const initialJavaScriptBytes = sum(initialAssets.map(sizeOf));
  const largestInitialChunkBytes = Math.max(0, ...initialAssets.map(sizeOf));
  const liveKitChunkBytes = sum(liveKitAssets.map(sizeOf));
  const totalJavaScriptBytes = sum(
    Object.entries(normalizedSizes)
      .filter(([asset]) => isJavaScriptAsset(asset))
      .map(([, bytes]) => bytes),
  );
  const totalCssBytes = sum(
    Object.entries(normalizedSizes)
      .filter(([asset]) => asset.endsWith(".css"))
      .map(([, bytes]) => bytes),
  );
  const initialSet = new Set(initialAssets.map(normalizeAssetPath));
  const eagerLiveKit = liveKitAssets
    .map(normalizeAssetPath)
    .filter((asset) => initialSet.has(asset));
  if (eagerLiveKit.length) {
    errors.push(`LiveKit became eager: ${eagerLiveKit.join(", ")}.`);
  }
  checkBudget(errors, "Initial JavaScript", initialJavaScriptBytes, budget.initialJavaScriptBytes);
  checkBudget(errors, "Largest initial chunk", largestInitialChunkBytes, budget.largestInitialChunkBytes);
  checkBudget(errors, "LiveKit lazy chunk", liveKitChunkBytes, budget.liveKitChunkBytes);
  checkBudget(errors, "Total client JavaScript", totalJavaScriptBytes, budget.totalJavaScriptBytes);
  checkBudget(errors, "Total client CSS", totalCssBytes, budget.totalCssBytes);

  return Object.freeze({
    initialAssets: Object.freeze(initialAssets),
    liveKitAssets: Object.freeze(liveKitAssets),
    initialJavaScriptBytes,
    largestInitialChunkBytes,
    liveKitChunkBytes,
    totalJavaScriptBytes,
    totalCssBytes,
    errors: Object.freeze(errors),
  });
}

export function normalizeAssetPath(value: string): string {
  return value.replace(/^\/+/, "");
}

function readEntryAssets(
  manifest: VinextClientAssetManifest,
  entry: string,
  errors: string[],
): ReadonlyArray<string> {
  const assets = manifest.dynamicPreloads[entry];
  if (!assets) {
    errors.push(`Client preload entry is missing: ${entry}.`);
    return [];
  }
  return assets;
}

function uniqueAssets(values: ReadonlyArray<string>): string[] {
  return [...new Set(values.map(normalizeAssetPath))];
}

function isJavaScriptAsset(value: string): boolean {
  return normalizeAssetPath(value).endsWith(".js");
}

function checkBudget(
  errors: string[],
  label: string,
  actual: number,
  limit: number,
): void {
  if (actual > limit) {
    errors.push(`${label} is ${actual} bytes; budget is ${limit} bytes.`);
  }
}

function sum(values: ReadonlyArray<number>): number {
  return values.reduce((total, value) => total + value, 0);
}

function readStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
