import assert from "node:assert/strict";
import test from "node:test";
import { getCardPresentation } from "../lib/game/card-presentation";
import type { Card, CardKind } from "../lib/game/types";

const CASES: Array<{
  center: string | null;
  corner: string;
  icon: ReturnType<typeof getCardPresentation>["icon"];
  kind: CardKind;
  label: string;
}> = [
  { kind: "number", corner: "8", center: "8", icon: null, label: "Number" },
  { kind: "draw_two", corner: "+2", center: "+2", icon: null, label: "Draw 2" },
  { kind: "draw_four", corner: "+4", center: "+4", icon: null, label: "Draw 4" },
  { kind: "skip", corner: "SKIP", center: null, icon: "skip", label: "Skip" },
  { kind: "reverse", corner: "REV", center: null, icon: "reverse", label: "Reverse" },
  { kind: "discard_all", corner: "ALL", center: null, icon: "cards", label: "Discard all" },
  { kind: "skip_everyone", corner: "ALL", center: null, icon: "skip_all", label: "Skip everyone" },
  { kind: "wild_reverse_draw_four", corner: "+4", center: null, icon: "reverse", label: "Reverse draw 4" },
  { kind: "wild_draw_six", corner: "+6", center: "+6", icon: null, label: "Draw 6" },
  { kind: "wild_draw_ten", corner: "+10", center: "+10", icon: null, label: "Draw 10" },
  { kind: "wild_color_roulette", corner: "WILD", center: null, icon: "aperture", label: "Color roulette" },
];

for (const expected of CASES) {
  test(`builds a complete visual model for ${expected.kind}`, () => {
    const card = makeCard(expected.kind);
    const presentation = getCardPresentation(card);
    assert.equal(presentation.cornerMark, expected.corner);
    assert.equal(presentation.centerMark, expected.center);
    assert.equal(presentation.icon, expected.icon);
    assert.equal(presentation.label, expected.label);
    assert.match(presentation.accessibleName, card.color ? /Red/ : /Wild/);
  });
}

test("wild cards keep their identity while announcing the active color", () => {
  const presentation = getCardPresentation(
    makeCard("wild_color_roulette"),
    "blue",
  );
  assert.equal(presentation.color, "wild");
  assert.equal(presentation.activeWildColor, "blue");
  assert.match(presentation.accessibleName, /Blue is active/);
});

function makeCard(kind: CardKind): Card {
  const number = kind === "number" ? 8 : null;
  const color = kind.startsWith("wild_") ? null : "red";
  return { id: `test-${kind}`, kind, color, number };
}
