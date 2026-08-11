import { GameRuleError } from "../game/errors";

const NO_STORE_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
};
const MAX_JSON_BODY_BYTES = 16_384;

export function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: NO_STORE_HEADERS });
}

export function routeErrorResponse(error: unknown): Response {
  if (error instanceof GameRuleError) {
    return jsonResponse(
      { error: { code: error.code, message: error.message } },
      error.status,
    );
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  const databaseUnavailable =
    message.includes("no such table") || message.includes("D1 binding");
  return jsonResponse(
    {
      error: {
        code: databaseUnavailable ? "DATABASE_UNAVAILABLE" : "INTERNAL_ERROR",
        message: databaseUnavailable
          ? "The game database is still being prepared. Please try again."
          : "The server could not complete that request.",
      },
    },
    500,
  );
}

export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    throw new GameRuleError("PAYLOAD_TOO_LARGE", "Request payload is too large.", 413);
  }

  let value: unknown;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Missing request body");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let totalBytes = 0;
    let text = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        void reader.cancel();
        throw new GameRuleError(
          "PAYLOAD_TOO_LARGE",
          "Request payload is too large.",
          413,
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    value = JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof GameRuleError) throw error;
    throw new GameRuleError("INVALID_JSON", "Request body is not valid JSON.", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GameRuleError("INVALID_BODY", "Request body must be a JSON object.", 400);
  }
  return value as Record<string, unknown>;
}

export function requireCommandId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 80 ||
    !/^[a-zA-Z0-9_-]+$/.test(value)
  ) {
    throw new GameRuleError(
      "INVALID_COMMAND_ID",
      "commandId must be an 8–80 character idempotency key.",
      400,
    );
  }
  return value;
}
