import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CardFace } from "../app/components/CardFace";
import { getCardPresentation } from "../lib/game/card-presentation";
import type { Card } from "../lib/game/types";

const CSS_SOURCE = readFileSync("app/globals.css", "utf8");

test("Wild Reverse Draw 4 keeps one draw value without a duplicate support badge", () => {
  const card: Card = {
    id: "readability-reverse-four",
    kind: "wild_reverse_draw_four",
    color: null,
    number: null,
  };
  const presentation = getCardPresentation(card);

  assert.equal(presentation.cornerMark, "+4");
  assert.equal(presentation.supportMark, null);
  assert.equal(presentation.icon, "reverse");
});

test("compact guide cards expose density hooks for long values and labels", () => {
  const drawTen = renderCard({
    id: "readability-draw-ten",
    kind: "wild_draw_ten",
    color: null,
    number: null,
  });
  const roulette = renderCard({
    id: "readability-roulette",
    kind: "wild_color_roulette",
    color: null,
    number: null,
  });

  assert.match(drawTen, /data-value-density="long"/u);
  assert.match(roulette, /data-label-density="long"/u);
  assert.match(
    CSS_SOURCE,
    /\.card-face\[data-value-density="long"\]\s+\.card-face__value\s*\{[^}]*font-size:\s*clamp\(22px,\s*34cqw,\s*52px\)/u,
  );
  assert.match(
    CSS_SOURCE,
    /\.card-face\[data-variant="compact"\]\[data-label-density="long"\]\s+\.card-face__label\s*\{[^}]*right:\s*8%/u,
  );
});

test("guide card artwork centers beside taller explanatory copy", () => {
  assert.match(
    CSS_SOURCE,
    /\.rules-guide-card-face\s*\{[^}]*align-self:\s*center\s*;?[^}]*\}/u,
  );
  assert.match(
    CSS_SOURCE,
    /\.rules-guide-card\s*\{[^}]*padding:\s*16px\s*;?[^}]*gap:\s*16px\s*;?[^}]*\}/u,
  );
});

function renderCard(card: Card): string {
  return renderToStaticMarkup(
    createElement(CardFace, {
      card,
      variant: "compact",
      interaction: { kind: "static", hiddenFromAssistiveTech: true },
    }),
  );
}
