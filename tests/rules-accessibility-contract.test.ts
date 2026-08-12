import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const GAME_SHELL_SOURCE = readFileSync(
  new URL("../app/components/GameShell.tsx", import.meta.url),
  "utf8",
);
const LANDING_SOURCE = readFileSync(
  new URL("../app/components/SignedOutLanding.tsx", import.meta.url),
  "utf8",
);
const RULES_GUIDE_SOURCE = readFileSync(
  new URL("../app/components/RulesGuide.tsx", import.meta.url),
  "utf8",
);
const CSS_SOURCE = readFileSync(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);

const CANONICAL_GUIDE_IMPORT =
  /from\s+["']\.\.\/\.\.\/lib\/game\/rules-guide["']/u;

test("signed-out and in-game rules render from the same canonical guide data", () => {
  assert.match(RULES_GUIDE_SOURCE, CANONICAL_GUIDE_IMPORT);
  assert.match(
    RULES_GUIDE_SOURCE,
    /OPEN_SHED_RULES_GUIDE|RULES_GUIDE_(?:SECTIONS|CARD_FAMILIES|SCORING_MODES)/u,
  );
  for (const surface of [LANDING_SOURCE, GAME_SHELL_SOURCE]) {
    assert.match(surface, /from\s+["']\.\/RulesGuide["']/u);
    assert.match(surface, /<RulesGuideSections\b/u);
    assert.match(surface, /<RulesGuideCards\b/u);
    assert.match(surface, /<RulesGuideDeckInventory\b/u);
    assert.match(surface, /<RulesGuideScoring\b/u);
  }
});

test("every in-game rules trigger exposes that it opens a dialog", () => {
  const ruleButtons = [...GAME_SHELL_SOURCE.matchAll(/<button\b[\s\S]*?<\/button>/gu)]
    .map(([source]) => source)
    .filter((source) => source.includes("openGuide("));

  assert.ok(ruleButtons.length >= 3, "expected header, quick-rules, and action-guide triggers");
  for (const source of ruleButtons) {
    assert.match(source, /aria-haspopup="dialog"/u);
  }
});

test("the long rules guide is one labelled document with a keyboard-usable table of contents", () => {
  assert.match(
    GAME_SHELL_SOURCE,
    /role="dialog"[\s\S]*?aria-modal="true"[\s\S]*?aria-labelledby="game-guide-title"/u,
  );
  assert.match(
    GAME_SHELL_SOURCE,
    /<nav\b[^>]*className="[^"]*(?:rules-guide-toc|guide-toc)[^"]*"[^>]*aria-label="Rules guide sections"/u,
  );
  assert.match(
    GAME_SHELL_SOURCE,
    /className="[^"]*(?:rules-guide-document|guide-document)[^"]*"[^>]*role="document"[^>]*aria-labelledby="game-guide-title"/u,
  );
  assert.match(
    GAME_SHELL_SOURCE,
    /href=(?:["']#game-guide-|\{`#game-guide-)/u,
  );
  assert.match(GAME_SHELL_SOURCE, /jumpToGuideSection|focusGuideSection/u);
  assert.match(GAME_SHELL_SOURCE, /tabIndex=\{-1\}/u);
  assert.match(GAME_SHELL_SOURCE, /\.focus\(\{\s*preventScroll:\s*true\s*\}\)/u);
  assert.match(GAME_SHELL_SOURCE, /scrollIntoView\(/u);
  assert.doesNotMatch(GAME_SHELL_SOURCE, /className="guide-tabs"/u);
});

test("the guide has valid heading structure and a semantic deck inventory", () => {
  assert.match(GAME_SHELL_SOURCE, /<h2 id="game-guide-title"/u);
  for (const sectionId of ["overview", "cards", "deck", "scoring"]) {
    assert.ok(
      RULES_GUIDE_SOURCE.includes(
        `aria-labelledby={\`${"${idPrefix}"}-${sectionId}-title\`}`,
      ),
      `${sectionId} section must be labelled by its visible heading`,
    );
    assert.ok(
      RULES_GUIDE_SOURCE.includes(`id={\`${"${idPrefix}"}-${sectionId}-title\`}`),
      `${sectionId} section heading must expose the referenced id`,
    );
  }
  assert.match(RULES_GUIDE_SOURCE, /<h3\b[^>]*tabIndex=\{-1\}/u);
  assert.match(
    RULES_GUIDE_SOURCE,
    /<dl\b[^>]*className="[^"]*rules-deck-inventory[^"]*"/u,
  );
  assert.match(RULES_GUIDE_SOURCE, /<dt>/u);
  assert.match(RULES_GUIDE_SOURCE, /<dd>/u);
  assert.doesNotMatch(
    `${GAME_SHELL_SOURCE}\n${RULES_GUIDE_SOURCE}`,
    /action-guide-list[\s\S]*?<article\b[^>]*>\s*<strong>/u,
  );
  const publicRulesSource = `${LANDING_SOURCE}\n${RULES_GUIDE_SOURCE}`;
  for (const [summary] of publicRulesSource.matchAll(/<summary\b[\s\S]*?<\/summary>/gu)) {
    assert.doesNotMatch(summary, /<h[1-6]\b/u, "summary content must remain valid phrasing content");
  }
});

test("the guide provides an early close control and a complete modal focus lifecycle", () => {
  const titleIndex = GAME_SHELL_SOURCE.indexOf('id="game-guide-title"');
  const closeIndex = GAME_SHELL_SOURCE.indexOf('aria-label="Close rules guide"');
  const tocIndex = Math.max(
    GAME_SHELL_SOURCE.indexOf("rules-guide-toc"),
    GAME_SHELL_SOURCE.indexOf("guide-toc"),
  );

  assert.ok(titleIndex >= 0, "guide title must exist");
  assert.ok(closeIndex > titleIndex, "close control must follow the visible guide title");
  assert.ok(tocIndex > closeIndex, "close control must appear before the long rules navigation");
  assert.match(GAME_SHELL_SOURCE, /guideCloseButtonRef\.current\?\.focus\(\)/u);
  assert.match(GAME_SHELL_SOURCE, /event\.key === "Escape"[\s\S]*?closeGuide\(\)/u);
  assert.match(
    GAME_SHELL_SOURCE,
    /event\.key !== "Tab"[\s\S]*?document\.activeElement === first[\s\S]*?last\.focus\(\)[\s\S]*?first\.focus\(\)/u,
  );
  assert.match(
    GAME_SHELL_SOURCE,
    /setGuideTopic\(null\)[\s\S]*?utilityTriggerRef\.current\?\.focus\(\)/u,
  );
  assert.match(GAME_SHELL_SOURCE, /inert=\{modalOpen \? true : undefined\}/u);
});

test("long rules lock background scrolling and contain modal scroll", () => {
  assert.match(
    GAME_SHELL_SOURCE,
    /document\.body\.style\.overflow\s*=\s*["']hidden["']/u,
  );
  assert.match(
    GAME_SHELL_SOURCE,
    /document\.body\.style\.overflow\s*=\s*(?:previous|original|bodyOverflow)/u,
  );
  assert.match(
    CSS_SOURCE,
    /\.choice-overlay\s*\{[\s\S]*?overscroll-behavior:\s*contain/u,
  );
  assert.match(
    CSS_SOURCE,
    /\.(?:rules-guide-document|guide-document|guide-panel)\s*\{[\s\S]*?overflow-y:\s*auto/u,
  );
});

test("rules remain readable and operable at 320px, 200 percent zoom, and reduced motion", () => {
  assert.match(
    CSS_SOURCE,
    /\.(?:rules-guide-close|guide-close)[^{]*\{[\s\S]*?min-(?:height|block-size):\s*(?:4[4-9]|[5-9]\d)px/u,
  );
  assert.match(
    CSS_SOURCE,
    /\.(?:rules-guide-toc|guide-toc)[^{]*(?:a|button)[^{]*\{[\s\S]*?min-(?:height|block-size):\s*(?:4[4-9]|[5-9]\d)px/u,
  );
  assert.match(
    CSS_SOURCE,
    /\.(?:rules-guide-document|guide-document)\s*\{[\s\S]*?font-size:\s*(?:1[4-9]|2\d)px[\s\S]*?line-height:\s*1\.[5-9]/u,
  );
  assert.match(
    CSS_SOURCE,
    /\.(?:rules-guide-document|guide-document)[\s\S]*?overflow-wrap:\s*(?:anywhere|break-word)/u,
  );
  assert.match(
    CSS_SOURCE,
    /@media \(max-width:\s*720px\)[\s\S]*?\.(?:guide-panel|rules-guide-panel)\s*\{[\s\S]*?width:\s*(?:100%|calc\(100vw\s*-\s*20px\))[\s\S]*?max-height:\s*calc\(100dvh\s*-\s*20px\)/u,
  );
  assert.match(
    CSS_SOURCE,
    /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?scroll-behavior:\s*auto\s*!important/u,
  );
});
