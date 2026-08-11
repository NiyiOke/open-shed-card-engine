import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SHELL_SOURCE = source("../app/components/GameShell.tsx");
const CSS_SOURCE = source("../app/globals.css");

test("the issue reporter stays available across the signed-in lobby, game, and result shell", () => {
  const header = sliceBetween(
    SHELL_SOURCE,
    '<header className="app-header"',
    "</header>",
  );
  assert.match(header, /aria-haspopup="dialog"/u);
  assert.match(header, /onClick=\{\(event\) => openBugReport\(event\.currentTarget\)\}/u);
  assert.match(header, />\s*Report issue\s*</u);

  assert.ok(
    SHELL_SOURCE.indexOf('<header className="app-header"') <
      SHELL_SOURCE.indexOf("{!game ? ("),
    "the persistent header entry point must not be nested inside one game phase",
  );
  assert.match(
    SHELL_SOURCE,
    /const modalOpen =[\s\S]*bugReportOpen[\s\S]*<header className="app-header" inert=\{modalOpen \? true : undefined\}/u,
  );
  assert.match(
    SHELL_SOURCE,
    /<div className="app-view" inert=\{modalOpen \? true : undefined\}>/u,
  );
});

test("the report dialog is labelled, focus-contained, Escape-safe, and restores its trigger", () => {
  const focusEffect = sliceBetween(
    SHELL_SOURCE,
    "if (!bugReportOpen) return;",
    "}, [bugReportOpen, closeBugReport]);",
  );
  assert.match(
    focusEffect,
    /button:not\(:disabled\), textarea:not\(:disabled\), input:not\(:disabled\), \[href\]/u,
  );
  assert.match(focusEffect, /bugReportDescriptionRef\.current[\s\S]*\.focus\(\)/u);
  assert.match(focusEffect, /event\.key === "Escape"[\s\S]*closeBugReport\(\)/u);
  assert.match(focusEffect, /event\.shiftKey[\s\S]*last\.focus\(\)/u);
  assert.match(focusEffect, /document\.activeElement === last[\s\S]*first\.focus\(\)/u);

  const closeHandler = sliceBetween(
    SHELL_SOURCE,
    "const closeBugReport = useCallback",
    "const copyBugReport",
  );
  assert.match(closeHandler, /setBugReportOpen\(false\)/u);
  assert.match(closeHandler, /bugReportTriggerRef\.current\?\.focus\(\)/u);

  const dialog = sliceBetween(
    SHELL_SOURCE,
    "{bugReportOpen ? (",
    "{chatDialog ? (",
  );
  assert.match(
    dialog,
    /role="dialog"[\s\S]*aria-modal="true"[\s\S]*aria-labelledby="bug-report-title"[\s\S]*aria-describedby="bug-report-privacy-note"/u,
  );
  assert.match(dialog, /<fieldset className="bug-report-categories">[\s\S]*<legend>/u);
  assert.match(dialog, /aria-invalid=\{Boolean\(bugReportError\)\}/u);
  assert.match(dialog, /aria-describedby="bug-report-description-hint bug-report-feedback"/u);
  assert.match(dialog, /id="bug-report-feedback"[\s\S]*aria-live="polite"/u);
});

test("outbound issue data requires an explicit validated user action and stays separate from private state", () => {
  const issueReportState = sliceBetween(
    SHELL_SOURCE,
    "issueReport: {",
    "game: game",
  );
  assert.match(issueReportState, /outboundAction: bugReportOpen \? "awaiting_explicit_user_click"/u);
  assert.doesNotMatch(
    issueReportState,
    /gameId|joinCode|playerId|displayName|hand|cardId|event\.message|event\.data|chat|auth|localStorage|sessionStorage/iu,
  );

  const reportPreparation = sliceBetween(
    SHELL_SOURCE,
    "const privateBugReportValues",
    "const requestInactiveRemoval",
  );
  assert.match(
    reportPreparation,
    /setBugReportPrivateCanaries\(privateBugReportValues\(current\)\)/u,
  );
  assert.match(
    reportPreparation,
    /validateBugReportDescription\([\s\S]*bugReportPrivateCanaries/u,
  );
  assert.match(reportPreparation, /navigator\.clipboard\.writeText\(buildBugReportDraft/u);

  const dialog = sliceBetween(
    SHELL_SOURCE,
    "{bugReportOpen ? (",
    "{chatDialog ? (",
  );
  assert.match(
    dialog,
    /\{bugReportIssueLink\.href \? \([\s\S]*href=\{bugReportIssueLink\.href\}[\s\S]*target="_blank"[\s\S]*rel="noopener noreferrer"/u,
  );
  assert.match(dialog, /onClick=\{\(\) => void copyBugReport\(\)\}/u);
  assert.match(dialog, /Nothing is submitted until you[\s\S]*Submit new issue/u);
  assert.match(dialog, /security\/policy/u);
  assert.doesNotMatch(SHELL_SOURCE, /window\.open\(/u);
  assert.doesNotMatch(dialog, /href=\{bugReportIssueLink\.href \?\? "#"\}/u);
});

test("mobile controls and every Color Roulette decision state remain explicit", () => {
  assert.match(
    CSS_SOURCE,
    /\.bug-report-categories label\s*\{[\s\S]*?min-height:\s*48px;/u,
  );
  assert.match(
    CSS_SOURCE,
    /\.bug-report-diagnostics summary\s*\{[\s\S]*?min-height:\s*44px;/u,
  );
  assert.match(
    CSS_SOURCE,
    /\.bug-report-actions > \*,[\s\S]*?\.bug-report-actions \.primary-button\s*\{[\s\S]*?min-height:\s*44px;/u,
  );
  assert.match(
    CSS_SOURCE,
    /\.bug-report-panel\s*\{[\s\S]*?width:\s*min\(700px, 100%\);/u,
  );

  assert.match(
    SHELL_SOURCE,
    /The next player—not you—chooses the color and draws until it appears\. Their\s+turn is skipped\./u,
  );
  assert.match(
    SHELL_SOURCE,
    /title: `\$\{rouletteTarget\?\.displayName \?\? "The next player"\} must choose the Roulette color`/u,
  );
  assert.match(
    SHELL_SOURCE,
    /The player who played Color Roulette does not choose\. The target draws until that color appears and loses this turn\./u,
  );
  assert.match(SHELL_SOURCE, /title: "Choose your Roulette color"/u);
  assert.match(SHELL_SOURCE, /title: "Your turn — draw until playable"/u);
  assert.match(
    SHELL_SOURCE,
    /No card in your hand matches \$\{game\.activeColor\}/u,
  );
  assert.match(
    SHELL_SOURCE,
    />\s*Your turn — draw until playable\s*</u,
  );
});

function sliceBetween(value: string, startMarker: string, endMarker: string): string {
  const start = value.indexOf(startMarker);
  const end = value.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  assert.ok(end > start, `missing source marker: ${endMarker}`);
  return value.slice(start, end);
}

function source(relativeUrl: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativeUrl, import.meta.url)),
    "utf8",
  );
}
