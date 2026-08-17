export interface EnvConfig {
  enabled: boolean;
  environment: string;
  allowedOrigins: ReadonlySet<string>;
  maxConnections: number;
  maxReadyConnectionsPerSubject: number;
  maxNotificationsPerSecond: number;
  maxBufferedBytes: number;
  heartbeatMs: number;
}

interface ConfigEnv {
  OPEN_SHED_REALTIME_ENABLED?: string;
  ENVIRONMENT?: string;
  ALLOWED_ORIGINS?: string;
  MAX_CONNECTIONS_PER_ROOM?: string;
  MAX_READY_CONNECTIONS_PER_SUBJECT?: string;
  MAX_NOTIFICATIONS_PER_SECOND?: string;
  MAX_BUFFERED_BYTES?: string;
  HEARTBEAT_MS?: string;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function parseAllowedOrigins(value: string | undefined): ReadonlySet<string> {
  if (value === undefined) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return new Set();
  }
  if (!Array.isArray(parsed)) return new Set();

  const origins = new Set<string>();
  for (const candidate of parsed) {
    if (typeof candidate !== "string") continue;
    try {
      const url = new URL(candidate);
      if ((url.protocol === "https:" || url.protocol === "http:") && url.origin === candidate) {
        origins.add(candidate);
      }
    } catch {
      // Invalid entries are ignored; an empty set fails closed.
    }
  }
  return origins;
}

export function readConfig(env: ConfigEnv): EnvConfig {
  const maxConnections = boundedInteger(env.MAX_CONNECTIONS_PER_ROOM, 64, 1, 256);
  return {
    enabled: env.OPEN_SHED_REALTIME_ENABLED === "true",
    environment: env.ENVIRONMENT ?? "production",
    allowedOrigins: parseAllowedOrigins(env.ALLOWED_ORIGINS),
    maxConnections,
    maxReadyConnectionsPerSubject: boundedInteger(env.MAX_READY_CONNECTIONS_PER_SUBJECT, 3, 1, 3),
    maxNotificationsPerSecond: boundedInteger(env.MAX_NOTIFICATIONS_PER_SECOND, 20, 1, 100),
    maxBufferedBytes: boundedInteger(env.MAX_BUFFERED_BYTES, 65_536, 4_096, 1_048_576),
    heartbeatMs: boundedInteger(env.HEARTBEAT_MS, 25_000, 10_000, 60_000),
  };
}

export function isAllowedOrigin(origin: string | null, allowedOrigins: ReadonlySet<string>): boolean {
  return origin !== null && allowedOrigins.has(origin);
}
