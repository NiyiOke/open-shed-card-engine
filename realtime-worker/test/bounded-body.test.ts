import assert from "node:assert/strict";
import test from "node:test";

import { PayloadTooLargeError, readBoundedUtf8Body } from "../src/bounded-body";

function streamedRequest(chunks: readonly Uint8Array[]): {
  request: Request;
  cancelled: () => boolean;
  pulls: () => number;
} {
  let index = 0;
  let pullCount = 0;
  let wasCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pullCount += 1;
      const chunk = chunks[index];
      index += 1;
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      wasCancelled = true;
    },
  }, { highWaterMark: 0 });
  const request = new Request("https://example.test/notify/room", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return { request, cancelled: () => wasCancelled, pulls: () => pullCount };
}

test("defensive body reader accepts an exact-limit stream independently of route headers", async () => {
  const fixture = streamedRequest([new TextEncoder().encode("a".repeat(1_024))]);
  assert.equal(fixture.request.headers.has("Content-Length"), false);
  assert.equal((await readBoundedUtf8Body(fixture.request, 1_024)).length, 1_024);
  assert.equal(fixture.cancelled(), false);
});

test("defensive body reader drains an ingress mismatch without buffering after byte 1025", async () => {
  const fixture = streamedRequest([
    new TextEncoder().encode("a".repeat(1_025)),
    new TextEncoder().encode("unread attacker-controlled tail"),
  ]);
  assert.equal(fixture.request.headers.has("Content-Length"), false);
  await assert.rejects(
    readBoundedUtf8Body(fixture.request, 1_024),
    (error: unknown) => error instanceof PayloadTooLargeError,
  );
  assert.equal(fixture.cancelled(), false);
  assert.equal(fixture.pulls(), 3, "the oversized chunk, tail, and stream end were consumed");
});

test("bounded body reader rejects invalid UTF-8", async () => {
  const fixture = streamedRequest([new Uint8Array([0xc3, 0x28])]);
  await assert.rejects(readBoundedUtf8Body(fixture.request, 1_024));
});
