import { GameRuleError } from "../game/errors";

export type AuthenticatedUser = {
  userId: string;
  suggestedName: string;
  development: boolean;
};

const USER_ID_HEADER = "oai-authenticated-user-id";
const USER_FULL_NAME_HEADER = "oai-authenticated-user-full-name";
const USER_FULL_NAME_ENCODING_HEADER = "oai-authenticated-user-full-name-encoding";
const DEV_USER_HEADER = "x-open-shed-dev-user";
const DEV_NAME_HEADER = "x-open-shed-dev-name";

export function getOptionalRequestUser(request: Request): AuthenticatedUser | null {
  // These identity headers are trusted only because OpenAI Sites authenticates
  // the request and injects them at its ingress. Any alternate deployment must
  // strip client-supplied copies and verify identity before forwarding them.
  const userId = request.headers.get(USER_ID_HEADER);
  if (userId) {
    const encodedName = request.headers.get(USER_FULL_NAME_HEADER);
    const fullName =
      encodedName &&
      request.headers.get(USER_FULL_NAME_ENCODING_HEADER) ===
        "percent-encoded-utf-8"
        ? safeDecode(encodedName)
        : null;
    return {
      userId,
      suggestedName: cleanNickname(fullName ?? generatedNickname(userId)),
      development: false,
    };
  }

  if (isLocalDevelopment(request)) {
    const requested = request.headers.get(DEV_USER_HEADER) ?? "local-player-1";
    const safeId = requested.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
    const localId = safeId || "local-player-1";
    return {
      userId: `dev:${localId}`,
      suggestedName: cleanNickname(
        request.headers.get(DEV_NAME_HEADER) ?? generatedNickname(localId),
      ),
      development: true,
    };
  }

  return null;
}

export function requireRequestUser(request: Request): AuthenticatedUser {
  const user = getOptionalRequestUser(request);
  if (!user) {
    throw new GameRuleError(
      "AUTHENTICATION_REQUIRED",
      "Sign in before creating or joining a game.",
      401,
    );
  }
  return user;
}

export function cleanNickname(value: string): string {
  const cleaned = Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 28);
  return cleaned || "Player";
}

export function assertSafeMutationRequest(request: Request): void {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new GameRuleError(
      "JSON_REQUIRED",
      "Mutations require an application/json request.",
      415,
    );
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") {
    throw new GameRuleError("CROSS_SITE_REQUEST", "Cross-site requests are blocked.", 403);
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new GameRuleError("ORIGIN_MISMATCH", "Request origin is not allowed.", 403);
  }
}

function isLocalDevelopment(request: Request): boolean {
  const hostname = new URL(request.url).hostname;
  return (
    process.env.NODE_ENV !== "production" &&
    (hostname === "localhost" || hostname === "127.0.0.1")
  );
}

function generatedNickname(seed: string): string {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `Player-${(hash >>> 0).toString(16).slice(-4).toUpperCase().padStart(4, "0")}`;
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
