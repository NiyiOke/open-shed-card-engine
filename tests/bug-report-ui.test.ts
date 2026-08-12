import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  BUG_REPORT_CATEGORIES,
  BUG_REPORT_DESCRIPTION_MAX_LENGTH,
  BUG_REPORT_MAX_URL_LENGTH,
  BUG_REPORT_REPOSITORY_URL,
  buildBugReportDraft,
  buildBugReportIssueUrl,
  createPrivateBugReportTerms,
  createSafeBugReportDiagnostics,
  createSafeBugReportLegalActions,
  validateBugReportDescription,
  viewportBucket,
} from "../app/components/bug-report";
import { APP_BUILD_ID, APP_VERSION } from "../lib/app-version";

const SAFE_DIAGNOSTICS = createSafeBugReportDiagnostics({
  phase: "playing",
  revision: 10,
  connection: "live",
  currentTurnIsSelf: false,
  activeColor: "red",
  pendingDraw: { total: 4, minimum: 4 },
  direction: "clockwise",
  playerCount: 2,
  viewportBucket: "desktop",
  rouletteChoice: "other",
  legalActions: ["choose_roulette_color", "leave_game"],
  recentEventKinds: ["game_started", "card_played", "roulette_resolved"],
});

test("issue categories and viewport buckets are fixed public enums", () => {
  assert.deepEqual(
    BUG_REPORT_CATEGORIES.map(({ id }) => id),
    ["turn_stuck", "card_behavior", "connection", "display_accessibility", "other"],
  );
  assert.equal(viewportBucket(320), "narrow");
  assert.equal(viewportBucket(600), "mobile");
  assert.equal(viewportBucket(900), "tablet");
  assert.equal(viewportBucket(1_440), "desktop");
});

test("safe diagnostics construct only the explicit privacy allowlist", () => {
  const diagnostics = createSafeBugReportDiagnostics({
    phase: "playing",
    revision: 41,
    connection: "reconnecting",
    currentTurnIsSelf: true,
    activeColor: "blue",
    pendingDraw: { total: 10, minimum: 6, sourcePlayerId: "private-player-id" },
    direction: "counterclockwise",
    playerCount: 99,
    viewportBucket: "mobile",
    rouletteChoice: "self",
    legalActions: ["play_card", "accept_penalty"],
    recentEventKinds: [
      "card_played",
      "attacker_shaped_semantic_event",
      "draw_penalty_stacked",
      "roulette_resolved",
    ],
    eventMessage: "Neo Oke played private-card-id at table X7AV5W",
    gameId: "46fb704a-6e60-47b2-8ed2-6c17f4fdfe6f",
  } as Parameters<typeof createSafeBugReportDiagnostics>[0] & {
    eventMessage: string;
    gameId: string;
  });

  assert.deepEqual(Object.keys(diagnostics), [
    "appVersion",
    "buildId",
    "phase",
    "revision",
    "rulesVersion",
    "protocolVersion",
    "connection",
    "currentTurnIsSelf",
    "activeColor",
    "pendingDraw",
    "direction",
    "playerCount",
    "viewportBucket",
    "rouletteChoice",
    "legalActions",
    "recentEventKinds",
  ]);
  assert.equal(diagnostics.appVersion, APP_VERSION);
  assert.equal(diagnostics.buildId, APP_BUILD_ID);
  assert.deepEqual(diagnostics.pendingDraw, { total: 10, minimum: 6 });
  assert.equal(diagnostics.playerCount, 6);
  assert.deepEqual(diagnostics.recentEventKinds, [
    "card_played",
    "draw_penalty_stacked",
    "roulette_resolved",
  ]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /Neo Oke|X7AV5W|46fb704a|private-player/i);
});

test("safe diagnostics include the release identity without deployment secrets", () => {
  assert.equal(SAFE_DIAGNOSTICS.appVersion, "1.5.1");
  assert.equal(SAFE_DIAGNOSTICS.buildId, APP_BUILD_ID);
  assert.doesNotMatch(
    JSON.stringify(SAFE_DIAGNOSTICS),
    /API_KEY|API_SECRET|LIVEKIT_URL|DATABASE|authorization|cookie/iu,
  );
});

test("legal-action diagnostics never contain card or player identifiers", () => {
  assert.deepEqual(
    createSafeBugReportLegalActions({
      canSetReady: false,
      canStart: false,
      canPlayCard: true,
      canDrawUntilPlayable: false,
      canAcceptPenalty: true,
      canChooseRouletteColor: true,
      canDeclareUno: false,
      canCatchUno: true,
      canRematch: false,
      canLeave: true,
    }),
    ["play_card", "accept_penalty", "choose_roulette_color", "catch_uno", "leave_game"],
  );
});

test("description validation normalizes Unicode and blocks private or deceptive content", () => {
  assert.deepEqual(validateBugReportDescription("  Ｔｕｒｎ seems stuck.  "), {
    ok: true,
    value: "Turn seems stuck.",
  });
  const privateTerms = createPrivateBugReportTerms({
    names: ["Neo Oke", "Player"],
    secrets: ["X7AV5W", "red-number-4-1"],
  });
  assert.ok(privateTerms.includes("Neo"));
  assert.ok(privateTerms.includes("Oke"));
  assert.ok(!privateTerms.includes("Player"));
  assert.equal(
    validateBugReportDescription("Neo appeared to be waiting.", privateTerms).ok,
    false,
  );
  assert.equal(
    validateBugReportDescription("The other player appeared to be waiting.", privateTerms).ok,
    true,
  );
  for (const description of [
    "Neo Oke saw both players wait.",
    "The table code was X7AV5W when it froze.",
    "The card red-number-4-1 would not play.",
  ]) {
    assert.equal(
      validateBugReportDescription(description, ["Neo Oke", "X7AV5W", "red-number-4-1"]).ok,
      false,
    );
  }
  for (const description of [
    "Email me at player@example.com about this.",
    "See https://example.com/private for details.",
    "Game 46fb704a-6e60-47b2-8ed2-6c17f4fdfe6f froze.",
    "The turn looked\u202estuck after the Wild.",
    "The turn contained\u0000a hidden byte.",
  ]) {
    assert.equal(validateBugReportDescription(description).ok, false);
  }
});

test("description bounds count Unicode code points, then the GitHub URL is capped", () => {
  const sixHundredAscii = "a".repeat(BUG_REPORT_DESCRIPTION_MAX_LENGTH);
  const sixHundredEmoji = "😀".repeat(BUG_REPORT_DESCRIPTION_MAX_LENGTH);
  assert.equal(Array.from(sixHundredEmoji).length, BUG_REPORT_DESCRIPTION_MAX_LENGTH);
  assert.equal(validateBugReportDescription(sixHundredAscii).ok, true);
  assert.equal(validateBugReportDescription(sixHundredEmoji).ok, true);
  assert.equal(validateBugReportDescription(`${sixHundredEmoji}😀`).ok, false);

  const asciiUrl = buildBugReportIssueUrl({
    category: "turn_stuck",
    description: sixHundredAscii,
    diagnostics: SAFE_DIAGNOSTICS,
  });
  assert.ok(asciiUrl.length <= BUG_REPORT_MAX_URL_LENGTH);
  assert.throws(
    () => buildBugReportIssueUrl({
      category: "turn_stuck",
      description: sixHundredEmoji,
      diagnostics: SAFE_DIAGNOSTICS,
    }),
    /BUG_REPORT_URL_TOO_LONG/,
  );
});

test("GitHub draft has one fixed destination and exact title/body query keys", () => {
  const input = {
    category: "turn_stuck" as const,
    description: "Both players appeared to be waiting after the Wild.",
    diagnostics: SAFE_DIAGNOSTICS,
  };
  const issueUrl = new URL(buildBugReportIssueUrl(input));
  const repositoryUrl = new URL(BUG_REPORT_REPOSITORY_URL);
  assert.equal(issueUrl.origin, repositoryUrl.origin);
  assert.equal(issueUrl.pathname, "/NiyiOke/open-shed-card-engine/issues/new");
  assert.deepEqual([...issueUrl.searchParams.keys()], ["title", "body"]);
  assert.match(issueUrl.searchParams.get("title") ?? "", /Turn seems stuck/);
  assert.match(issueUrl.searchParams.get("body") ?? "", /Safe diagnostics/);

  const draft = buildBugReportDraft(input);
  assert.doesNotMatch(draft.text, /Neo Oke|X7AV5W|46fb704a|red-number-4-1/);
  assert.doesNotMatch(draft.text, /eventMessage|sourcePlayerId/);
});

test("GameShell exposes a focus-safe public review flow and Roulette clarification", () => {
  const source = readFileSync(new URL("../app/components/GameShell.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(source, /Report issue/);
  assert.match(source, /role="dialog"[\s\S]*aria-modal="true"[\s\S]*bug-report-title/);
  assert.match(source, /target="_blank"[\s\S]*rel="noopener noreferrer"/);
  assert.doesNotMatch(source, /href=\{bugReportIssueLink\.href \?\? "#"\}/);
  assert.match(source, /Nothing is submitted until you/);
  assert.match(source, /security\/policy/);
  assert.match(
    source,
    /The next player—not you—chooses the color and draws until it appears\. Their\s+turn is skipped\./,
  );
  assert.match(styles, /\.bug-report-categories label\s*\{[\s\S]*?min-height:\s*48px/);
  assert.match(styles, /\.bug-report-actions > \*[\s\S]*?min-height:\s*44px/);
});
