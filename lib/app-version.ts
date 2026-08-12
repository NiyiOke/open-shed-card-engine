/**
 * Canonical player-facing application release identity.
 *
 * Rules and protocol versions are separate compatibility contracts. Game
 * revisions are per-table counters. Neither should be presented as the app
 * version.
 */
export const APP_VERSION = "1.6.0" as const;
export const APP_VERSION_LABEL = `V${APP_VERSION}` as const;
export const APP_RELEASE_LABEL = `Open Shed ${APP_VERSION_LABEL}` as const;

export const PUBLIC_BUILD_ID_ENV = "NEXT_PUBLIC_OPEN_SHED_BUILD_ID" as const;
export const PUBLIC_BUILD_ID_MAX_LENGTH = 64;

/**
 * A build identifier is optional public metadata, never a secret-bearing
 * deployment payload. Accept only a short ASCII slug suitable for a commit or
 * CI build label.
 */
export function normalizePublicBuildId(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > PUBLIC_BUILD_ID_MAX_LENGTH ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

// NEXT_PUBLIC_ is intentional: this one allowlisted, non-secret value may be
// embedded in the browser bundle. No provider environment object is exposed.
export const APP_BUILD_ID = normalizePublicBuildId(
  process.env.NEXT_PUBLIC_OPEN_SHED_BUILD_ID,
);

export type AppReleaseIdentity = Readonly<{
  appVersion: typeof APP_VERSION;
  buildId: string | null;
}>;

export const APP_RELEASE_IDENTITY: AppReleaseIdentity = Object.freeze({
  appVersion: APP_VERSION,
  buildId: APP_BUILD_ID,
});
