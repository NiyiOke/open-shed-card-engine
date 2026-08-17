import {
  getRealtimeConfig,
  opaqueRealtimeRoomKey,
  signRealtimeNotification,
} from "./realtime-ticket";

export type RealtimeTopic = "game" | "chat";

const NOTIFICATION_TIMEOUT_MS = 750;

/**
 * Sends a content-free, post-commit invalidation to the realtime companion.
 * Delivery is intentionally best-effort: D1 is authoritative and browser
 * polling remains the recovery path.
 */
export async function notifyRealtimeChange(
  gameId: string,
  topics: readonly RealtimeTopic[],
): Promise<void> {
  const config = getRealtimeConfig();
  if (!config) return;
  const normalizedTopics = [...new Set(topics)]
    .filter((topic): topic is RealtimeTopic => topic === "game" || topic === "chat")
    .sort();
  if (!normalizedTopics.length) return;
  try {
    const room = await opaqueRealtimeRoomKey(config.sharedSecret, gameId);
    const body = JSON.stringify({ v: 1, topics: normalizedTopics });
    const timestamp = Date.now();
    const nonce = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
    const signature = await signRealtimeNotification(config.sharedSecret, {
      room,
      timestamp,
      nonce,
      body,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), NOTIFICATION_TIMEOUT_MS);
    try {
      await fetch(`${config.httpOrigin}/notify/${room}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "open-shed-realtime-signature": signature,
          "open-shed-realtime-timestamp": String(timestamp),
          "open-shed-realtime-nonce": nonce,
        },
        body,
        signal: controller.signal,
        // Workerd does not implement automatic redirect rejection. Manual mode
        // retains the security property we need here: notification requests
        // never follow a redirect to another origin.
        redirect: "manual",
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    // Preparation and delivery can never change a committed response.
  }
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}
