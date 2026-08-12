import assert from "node:assert/strict";
import test from "node:test";
import {
  OPEN_SHED_RULES_GUIDE,
  RULES_GUIDE_CARD_FAMILIES,
  RULES_GUIDE_CARDS_BY_KIND,
  RULES_GUIDE_SCORING_MODES,
  RULES_GUIDE_SECTIONS,
} from "../lib/game/rules-guide";
import { RULES_VERSION, type CardKind } from "../lib/game/types";

const EXPECTED_KINDS: readonly CardKind[] = [
  "number",
  "draw_two",
  "draw_four",
  "skip",
  "reverse",
  "discard_all",
  "skip_everyone",
  "wild_reverse_draw_four",
  "wild_draw_six",
  "wild_draw_ten",
  "wild_color_roulette",
];

test("the shared guide describes every core card kind and all 168 cards", () => {
  assert.equal(OPEN_SHED_RULES_GUIDE.rulesProfile, RULES_VERSION);
  assert.equal(OPEN_SHED_RULES_GUIDE.facts.deckSize, 168);
  assert.deepEqual(Object.keys(RULES_GUIDE_CARDS_BY_KIND), EXPECTED_KINDS);

  assert.deepEqual(
    Object.fromEntries(
      EXPECTED_KINDS.map((kind) => [kind, RULES_GUIDE_CARDS_BY_KIND[kind].totalCopies]),
    ),
    {
      number: 80,
      draw_two: 12,
      draw_four: 8,
      skip: 12,
      reverse: 12,
      discard_all: 12,
      skip_everyone: 8,
      wild_reverse_draw_four: 8,
      wild_draw_six: 4,
      wild_draw_ten: 4,
      wild_color_roulette: 8,
    },
  );

  assert.deepEqual(
    RULES_GUIDE_CARD_FAMILIES.map((family) => [family.id, family.totalCopies]),
    [
      ["numbers", 80],
      ["color_actions", 64],
      ["wild_actions", 24],
    ],
  );
  assert.equal(
    RULES_GUIDE_CARD_FAMILIES.reduce((total, family) => total + family.totalCopies, 0),
    168,
  );
  assert.equal(
    RULES_GUIDE_CARD_FAMILIES.flatMap((family) => family.cards).reduce(
      (total, card) => total + card.totalCopies,
      0,
    ),
    168,
  );
  for (const family of RULES_GUIDE_CARD_FAMILIES) {
    assert.equal(
      family.cards.reduce((total, card) => total + card.totalCopies, 0),
      family.totalCopies,
    );
  }
  for (const card of Object.values(RULES_GUIDE_CARDS_BY_KIND)) {
    assert.ok(card.summary.length > 0);
    assert.ok(card.details.length > 0);
  }
});

test("the guide exposes concise and detailed copy for the complete rules path", () => {
  assert.deepEqual(
    RULES_GUIDE_SECTIONS.map((section) => section.id),
    [
      "setup",
      "turn",
      "stacking",
      "mercy",
      "zero_seven",
      "uno",
      "winning",
      "recycling",
      "online_edges",
    ],
  );

  for (const section of RULES_GUIDE_SECTIONS) {
    assert.ok(section.title.length > 0);
    assert.ok(section.summary.length > 0);
    assert.ok(section.details.length > 0);
    assert.ok(section.details.every((detail) => detail.length > 0));
  }

  assert.match(section("stacking").summary, /last Draw card/u);
  assert.match(section("stacking").details.join(" "), /not the accumulated total/u);
  assert.match(section("mercy").summary, /25 cards/u);
  assert.match(section("zero_seven").summary, /Zero passes/u);
  assert.match(section("uno").details.join(" "), /draws two/u);
  assert.match(section("winning").summary, /final card/u);
  assert.match(section("recycling").details.join(" "), /Mercy hands/u);
  assert.match(section("online_edges").details.join(" "), /Roulette color is absent/u);
});

test("card copy includes the effect details most likely to drift between renderers", () => {
  assert.match(
    RULES_GUIDE_CARDS_BY_KIND.discard_all.details.join(" "),
    /do not activate/u,
  );
  assert.match(
    RULES_GUIDE_CARDS_BY_KIND.wild_color_roulette.details.join(" "),
    /Wild cards do not count/u,
  );
  assert.match(
    RULES_GUIDE_CARDS_BY_KIND.wild_color_roulette.details.join(" "),
    /loses their turn/u,
  );
  assert.match(
    RULES_GUIDE_CARDS_BY_KIND.wild_reverse_draw_four.details.join(" "),
    /only two active players/u,
  );
  assert.equal(RULES_GUIDE_CARDS_BY_KIND.number.copiesPerRankPerColor, 2);
});

test("the optional 1,000-point method is explicit and disabled", () => {
  const roundWins = scoringMode("round_wins");
  const points = scoringMode("points_1000");

  assert.equal(roundWins.availability, "enabled");
  assert.match(roundWins.details.join(" "), /not the optional card-points method/u);
  assert.equal(points.availability, "disabled");
  assert.equal(points.target, 1_000);
  assert.match(points.summary, /not enabled/u);
  assert.match(points.details.join(" "), /face value/u);
  assert.match(points.details.join(" "), /20/u);
  assert.match(points.details.join(" "), /50/u);
  assert.match(points.details.join(" "), /250-point bonus/u);
});

test("the renderer-facing rules API is deeply immutable", () => {
  assertDeeplyFrozen(OPEN_SHED_RULES_GUIDE);
  assertDeeplyFrozen(RULES_GUIDE_CARDS_BY_KIND);
  assert.equal(RULES_GUIDE_CARD_FAMILIES, OPEN_SHED_RULES_GUIDE.cardFamilies);
  assert.equal(RULES_GUIDE_SECTIONS, OPEN_SHED_RULES_GUIDE.sections);
  assert.equal(RULES_GUIDE_SCORING_MODES, OPEN_SHED_RULES_GUIDE.scoringModes);

  assert.throws(
    () => {
      (RULES_GUIDE_SECTIONS as unknown as RuleGuideSectionMutation[]).push({
        id: "unexpected",
      });
    },
    TypeError,
  );
  assert.match(OPEN_SHED_RULES_GUIDE.sourceNote, /independently authored/u);
  assert.match(OPEN_SHED_RULES_GUIDE.sourceNote, /not an official rulebook/u);
});

type RuleGuideSectionMutation = { id: string };

function section(id: (typeof RULES_GUIDE_SECTIONS)[number]["id"]) {
  const found = RULES_GUIDE_SECTIONS.find((candidate) => candidate.id === id);
  assert.ok(found);
  return found;
}

function scoringMode(id: (typeof RULES_GUIDE_SCORING_MODES)[number]["id"]) {
  const found = RULES_GUIDE_SCORING_MODES.find((candidate) => candidate.id === id);
  assert.ok(found);
  return found;
}

function assertDeeplyFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeeplyFrozen(child);
}
