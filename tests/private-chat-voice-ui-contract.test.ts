import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SHELL_SOURCE = source("../app/components/GameShell.tsx");
const CHAT_SOURCE = source("../app/components/chat-ui.ts");
const CSS_SOURCE = source("../app/globals.css");

test("free text is capability-gated, bounded, plain React text", () => {
  assert.match(CHAT_SOURCE, /CHAT_TEXT_MAX_GRAPHEMES = 160/u);
  assert.match(CHAT_SOURCE, /capabilities:\s*\{[\s\S]*freeText: boolean/u);
  assert.match(CHAT_SOURCE, /kind: "text";[\s\S]*body: string/u);
  assert.match(SHELL_SOURCE, /chatFreeTextEnabled \? \([\s\S]*chat-text-composer/u);
  assert.match(
    SHELL_SOURCE,
    /JSON\.stringify\(\{[\s\S]*commandId: requestCommandId,[\s\S]*kind: "text",[\s\S]*body: preparedChatDraft/u,
  );
  assert.match(
    SHELL_SOURCE,
    /FREE_TEXT_DISABLED", "FREE_TEXT_UNAVAILABLE"[\s\S]*setChatFreeTextEnabled\(false\)/u,
  );
  assert.match(SHELL_SOURCE, /CONTACT_DETAILS_NOT_ALLOWED[\s\S]*Links and contact details aren’t allowed/u);
  assert.match(SHELL_SOURCE, /INVALID_FREE_TEXT[\s\S]*1–\$\{CHAT_TEXT_MAX_GRAPHEMES\}/u);
  assert.match(
    SHELL_SOURCE,
    /<span className="chat-message__text">\{message\.body\}<\/span>/u,
  );
  assert.doesNotMatch(SHELL_SOURCE, /dangerouslySetInnerHTML/u);
  assert.doesNotMatch(
    SHELL_SOURCE,
    /CHAT_DRAFT_STORAGE|localStorage\.setItem\([^)]*(?:chatDraft|chat-draft)/iu,
  );
});

test("voice stays private, muted by default, and permission follows an explicit click", () => {
  for (const status of [
    "unavailable",
    "available",
    "prejoin",
    "requesting_permission",
    "permission_denied",
    "joining",
    "joined_muted",
    "joined_live",
    "reconnecting",
    "listen_only",
    "failed",
    "ended",
  ]) {
    assert.match(SHELL_SOURCE, new RegExp(`${status}:|"${status}"`, "u"));
  }
  assert.match(
    SHELL_SOURCE,
    /createLiveVoiceController\([\s\S]*if \(chatLiveVoiceEnabled\) controller\.markAvailable\(\)/u,
  );
  assert.match(SHELL_SOURCE, /void controller\.dispose\(\)/u);
  assert.match(SHELL_SOURCE, /liveVoiceControllerRef\.current\?\.openPrejoin\(\)/u);
  assert.match(SHELL_SOURCE, />\s*Join muted\s*</u);
  assert.match(
    SHELL_SOURCE,
    /choose to turn your microphone on[\s\S]*toggleLiveMicrophone/u,
  );
  assert.match(
    SHELL_SOURCE,
    /restriction === "block" && enabled[\s\S]*liveVoiceControllerRef\.current\?\.leave\(\)/u,
  );
  assert.match(
    SHELL_SOURCE,
    /chatEnabled && \(chatLiveVoiceEnabled \|\| liveVoiceJoined\)[\s\S]*mobile-talk-control/u,
  );
  assert.match(
    SHELL_SOURCE,
    /chatLiveVoiceEnabled \|\| liveVoiceJoined \? \([\s\S]*voice-strip/u,
  );
  assert.match(
    SHELL_SOURCE,
    /Block &amp; disconnect[\s\S]*openVoiceBlockDialog|openVoiceBlockDialog[\s\S]*Block &amp; disconnect/u,
  );
  assert.match(CSS_SOURCE, /\.voice-participant-block \{[\s\S]*min-height: 44px;/u);
  assert.doesNotMatch(SHELL_SOURCE, /navigator\.mediaDevices|getUserMedia/u);
});

test("mobile Talk and the prejoin sheet remain touch-safe at 320px", () => {
  assert.match(SHELL_SOURCE, /className="mobile-talk-control"[\s\S]*aria-haspopup="dialog"/u);
  assert.match(SHELL_SOURCE, /className="choice-overlay voice-sheet-overlay"[\s\S]*aria-modal="true"/u);
  assert.match(SHELL_SOURCE, /voice is optional and is not recorded/u);
  assert.match(CSS_SOURCE, /\.mobile-talk-control \{[\s\S]*min-height: 44px;/u);
  assert.match(
    CSS_SOURCE,
    /\.voice-sheet \{[\s\S]*max-height: min\(78dvh, 700px\)/u,
  );
  assert.match(
    CSS_SOURCE,
    /\.voice-sheet-actions > \* \{[\s\S]*min-height: 44px;/u,
  );
});

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}
