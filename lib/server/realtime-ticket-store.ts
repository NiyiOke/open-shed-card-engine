import { GameRuleError } from "../game/errors";

type Dependencies = Readonly<{
  database?: D1Database;
  now?: number;
}>;

const WINDOW_MS = 60_000;
const RULES = Object.freeze({
  profileGame: 10,
  profile: 30,
  room: 120,
} as const);

/**
 * Bounds ticket minting before the companion sees any connection attempt.
 * Quota keys are one-way hashes so the short-lived quota table does not gain
 * a new raw account-to-table relationship.
 */
export async function enforceRealtimeTicketQuota(
  authSubject: string,
  gameId: string,
  dependencies: Dependencies = {},
): Promise<void> {
  const database = dependencies.database ?? await productionDatabase();
  const now = dependencies.now ?? Date.now();
  const [profileKey, roomKey] = await Promise.all([
    quotaKey(authSubject),
    quotaKey(gameId),
  ]);
  const rules = [
    { scope: `realtime:profile-game:${profileKey}:${roomKey}`, limit: RULES.profileGame },
    { scope: `realtime:profile:${profileKey}`, limit: RULES.profile },
    { scope: `realtime:room:${roomKey}`, limit: RULES.room },
  ] as const;
  const bucketStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;

  for (const rule of rules) {
    const row = await database
      .prepare(
        `INSERT INTO mutation_quotas (scope, bucket_start, count, expires_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(scope, bucket_start) DO UPDATE SET
           count = mutation_quotas.count + 1,
           expires_at = excluded.expires_at
         RETURNING count`,
      )
      .bind(
        rule.scope,
        bucketStart,
        bucketStart + WINDOW_MS + 5 * 60_000,
      )
      .first<{ count: number }>();
    if (Number(row?.count ?? 0) > rule.limit) {
      throw new GameRuleError(
        "RATE_LIMITED",
        "Too many real-time connection requests. Please wait and try again.",
        429,
      );
    }
  }
}

async function productionDatabase(): Promise<D1Database> {
  const { ensureDatabaseSchema } = await import("../../db/runtime");
  return ensureDatabaseSchema();
}

async function quotaKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}
