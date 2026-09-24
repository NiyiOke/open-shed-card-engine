export class PayloadTooLargeError extends Error {
  constructor() {
    super("payload_too_large");
    this.name = "PayloadTooLargeError";
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true });

export async function readBoundedUtf8Body(request: Request, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("invalid_body_limit");
  if (request.body === null) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let tooLarge = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (tooLarge || totalBytes + value.byteLength > maxBytes) {
        tooLarge = true;
        continue;
      }
      totalBytes += value.byteLength;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (tooLarge) throw new PayloadTooLargeError();

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(body);
}
