import { RULES_VERSION, type CardKind } from "./types";

export const RULES_GUIDE_VERSION = "open-shed-rules-guide-v1" as const;

export type RuleGuideCopy = Readonly<{
  summary: string;
  details: readonly string[];
}>;

export type RuleGuideSectionId =
  | "setup"
  | "turn"
  | "stacking"
  | "mercy"
  | "zero_seven"
  | "uno"
  | "winning"
  | "recycling"
  | "online_edges";

export type RuleGuideSection = RuleGuideCopy &
  Readonly<{
    id: RuleGuideSectionId;
    title: string;
  }>;

export type RuleGuideCardFamilyId =
  | "numbers"
  | "color_actions"
  | "wild_actions";

export type RuleGuideCard = RuleGuideCopy &
  Readonly<{
    kind: CardKind;
    familyId: RuleGuideCardFamilyId;
    title: string;
    totalCopies: number;
    copiesPerColor?: number;
    copiesPerRankPerColor?: number;
  }>;

export type RuleGuideCardMap = Readonly<{
  [Kind in CardKind]: RuleGuideCard & Readonly<{ kind: Kind }>;
}>;

export type RuleGuideCardFamily = Readonly<{
  id: RuleGuideCardFamilyId;
  title: string;
  totalCopies: number;
  summary: string;
  cards: readonly RuleGuideCard[];
}>;

export type RuleGuideScoringMode = RuleGuideCopy &
  Readonly<{
    id: "round_wins" | "points_1000";
    title: string;
    availability: "enabled" | "disabled";
    target?: number;
  }>;

export type OpenShedRulesGuide = Readonly<{
  guideVersion: typeof RULES_GUIDE_VERSION;
  rulesProfile: typeof RULES_VERSION;
  title: string;
  sourceNote: string;
  facts: Readonly<{
    minimumPlayers: 2;
    maximumPlayers: 6;
    startingHandSize: 7;
    deckSize: 168;
    mercyLimit: 25;
  }>;
  sections: readonly RuleGuideSection[];
  cardFamilies: readonly RuleGuideCardFamily[];
  scoringModes: readonly RuleGuideScoringMode[];
}>;

type DeepReadonly<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

function deepFreeze<Value>(value: Value): DeepReadonly<Value> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value as DeepReadonly<Value>;
  }

  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value) as DeepReadonly<Value>;
}

const cardGuideByKind = {
  number: {
    kind: "number",
    familyId: "numbers",
    title: "Number cards",
    totalCopies: 80,
    copiesPerColor: 20,
    copiesPerRankPerColor: 2,
    summary: "Match the active color or number.",
    details: [
      "Each color has two copies of every number from 0 through 9.",
      "Zero passes every active hand in the current direction; seven forces a hand swap.",
    ],
  },
  draw_two: {
    kind: "draw_two",
    familyId: "color_actions",
    title: "Draw 2",
    totalCopies: 12,
    copiesPerColor: 3,
    summary: "The next active player faces a two-card penalty.",
    details: [
      "They may stack an equal-or-higher Draw card or take the complete penalty and lose their turn.",
    ],
  },
  draw_four: {
    kind: "draw_four",
    familyId: "color_actions",
    title: "Draw 4",
    totalCopies: 8,
    copiesPerColor: 2,
    summary: "The next active player faces a four-card penalty.",
    details: [
      "This is a colored Action card. It follows ordinary color or symbol matching outside a draw chain.",
      "The target may stack an equal-or-higher Draw card or take the complete penalty and lose their turn.",
    ],
  },
  skip: {
    kind: "skip",
    familyId: "color_actions",
    title: "Skip",
    totalCopies: 12,
    copiesPerColor: 3,
    summary: "The next active player loses their turn.",
    details: ["Play continues with the following active player in the current direction."],
  },
  reverse: {
    kind: "reverse",
    familyId: "color_actions",
    title: "Reverse",
    totalCopies: 12,
    copiesPerColor: 3,
    summary: "Reverse the direction of play.",
    details: [
      "With only two active players, Reverse skips the other player and returns play to its actor.",
    ],
  },
  discard_all: {
    kind: "discard_all",
    familyId: "color_actions",
    title: "Discard All",
    totalCopies: 12,
    copiesPerColor: 3,
    summary: "Discard every other card in your hand with this card's color.",
    details: [
      "Place those extra cards beneath Discard All. Their numbers and effects do not activate.",
      "The same-color removal is part of this play and completes before victory is checked.",
    ],
  },
  skip_everyone: {
    kind: "skip_everyone",
    familyId: "color_actions",
    title: "Skip Everyone",
    totalCopies: 8,
    copiesPerColor: 2,
    summary: "Skip every other active player and take another turn.",
    details: ["Direction does not change."],
  },
  wild_reverse_draw_four: {
    kind: "wild_reverse_draw_four",
    familyId: "wild_actions",
    title: "Wild Reverse Draw 4",
    totalCopies: 8,
    summary: "Choose the continuing color, reverse play, and send a four-card penalty.",
    details: [
      "The next active player in the new direction may stack or must draw the complete penalty and lose their turn.",
      "With only two active players, the penalty returns to the actor, who may stack it back.",
    ],
  },
  wild_draw_six: {
    kind: "wild_draw_six",
    familyId: "wild_actions",
    title: "Wild Draw 6",
    totalCopies: 4,
    summary: "Choose the continuing color and send a six-card penalty.",
    details: [
      "The next active player may stack an equal-or-higher Draw card or take the complete penalty and lose their turn.",
    ],
  },
  wild_draw_ten: {
    kind: "wild_draw_ten",
    familyId: "wild_actions",
    title: "Wild Draw 10",
    totalCopies: 4,
    summary: "Choose the continuing color and send a ten-card penalty.",
    details: [
      "The next active player may stack another Draw 10 or take the complete penalty and lose their turn.",
    ],
  },
  wild_color_roulette: {
    kind: "wild_color_roulette",
    familyId: "wild_actions",
    title: "Wild Color Roulette",
    totalCopies: 8,
    summary: "The next active player chooses a color and reveals until that color appears.",
    details: [
      "Wild cards do not count as the chosen color.",
      "The target takes the complete revealed batch, loses their turn, and leaves their chosen color active.",
    ],
  },
} satisfies RuleGuideCardMap;

const sections = [
  {
    id: "setup",
    title: "Set up the table",
    summary: "Seat 2–6 players, deal seven cards each, and begin clockwise.",
    details: [
      "The host is the online dealer, and the next active seat takes the first turn.",
      "Reveal opening cards until a number appears. Ignored Action cards stay below it without resolving.",
    ],
  },
  {
    id: "turn",
    title: "Take a turn",
    summary: "Play one card that matches the active color, number, or symbol, or play a Wild.",
    details: [
      "If a legal card is already in your hand, you must play one.",
      "If none is legal, draw until the first playable card appears, then play that exact card.",
    ],
  },
  {
    id: "stacking",
    title: "Stack draw penalties",
    summary: "Stack a Draw card equal to or higher than the last Draw card, or take the full total.",
    details: [
      "Normal color, number, and symbol matching is suspended during a draw chain.",
      "Each stacked value adds to the penalty; eligibility compares with the last printed Draw value, not the accumulated total.",
      "A player who accepts the penalty draws the total and loses their turn.",
    ],
  },
  {
    id: "mercy",
    title: "Survive Mercy",
    summary: "Reaching 25 cards knocks a player out immediately.",
    details: [
      "Ordinary draws, stacked penalties, and UNO catches stop as card 25 enters the hand.",
      "Color Roulette adds its complete revealed batch before checking the Mercy limit.",
      "A knocked-out hand is set aside until the Draw pile must be rebuilt.",
    ],
  },
  {
    id: "zero_seven",
    title: "Move hands with 0 and 7",
    summary: "Zero passes all active hands; seven swaps your hand with one active player.",
    details: [
      "A zero moves every post-play hand one active seat in the current direction.",
      "A seven requires its actor to choose another active player for the post-play hand swap.",
      "A hand movement that leaves someone with exactly one card opens an UNO call-or-catch window.",
    ],
  },
  {
    id: "uno",
    title: "Call UNO",
    summary: "Call UNO whenever a move leaves you with exactly one card.",
    details: [
      "Another active player may catch an open UNO liability before the next substantive turn action is accepted.",
      "A caught player draws two cards and is subject to the Mercy limit.",
    ],
  },
  {
    id: "winning",
    title: "Win the round",
    summary: "Shed your final card or become the last active player.",
    details: [
      "A final card wins before an effect that would target another hand.",
      "Discard All removes its matching cards as part of the actor's play before checking for an empty hand.",
    ],
  },
  {
    id: "recycling",
    title: "Rebuild the Draw pile",
    summary: "Keep the visible discard and shuffle every recyclable card into a new Draw pile.",
    details: [
      "Older discards and set-aside Mercy hands return to play; the visible top discard stays in place.",
      "Production shuffles use private randomness and are never derived from a public table code.",
    ],
  },
  {
    id: "online_edges",
    title: "Resolve online edge cases",
    summary: "The versioned rules profile keeps ambiguous outcomes deterministic.",
    details: [
      "Only active seats receive turns, zero passes, seven swaps, and action-card targets.",
      "Two-player Reverse behavior begins whenever only two active players remain.",
      "If a Roulette color is absent from every recyclable card, the target keeps the full revealed batch and play continues with that color active.",
      "The visible opening number never triggers its zero or seven hand-moving rule.",
    ],
  },
] satisfies readonly RuleGuideSection[];

const cardFamilies = [
  {
    id: "numbers",
    title: "Number cards",
    totalCopies: 80,
    summary: "Numbers 0–9 in four colors, with two copies of each rank per color.",
    cards: [cardGuideByKind.number],
  },
  {
    id: "color_actions",
    title: "Color Action cards",
    totalCopies: 64,
    summary: "Six action types that keep their printed color.",
    cards: [
      cardGuideByKind.draw_two,
      cardGuideByKind.draw_four,
      cardGuideByKind.skip,
      cardGuideByKind.reverse,
      cardGuideByKind.discard_all,
      cardGuideByKind.skip_everyone,
    ],
  },
  {
    id: "wild_actions",
    title: "Wild Action cards",
    totalCopies: 24,
    summary: "Four action types that set the continuing color through their required choice.",
    cards: [
      cardGuideByKind.wild_reverse_draw_four,
      cardGuideByKind.wild_draw_six,
      cardGuideByKind.wild_draw_ten,
      cardGuideByKind.wild_color_roulette,
    ],
  },
] satisfies readonly RuleGuideCardFamily[];

const scoringModes = [
  {
    id: "round_wins",
    title: "Round wins",
    availability: "enabled",
    summary: "Open Shed currently tracks one win for each completed round.",
    details: [
      "This is a simple game-night history, not the optional card-points method.",
      "Rematches keep the same table, players, round count, win count, and recent winners.",
    ],
  },
  {
    id: "points_1000",
    title: "Optional points to 1,000",
    availability: "disabled",
    target: 1_000,
    summary: "The reference rules' optional card-points victory method is not enabled.",
    details: [
      "Number cards score their face value, Color Action cards score 20, and Wild Action cards score 50.",
      "Each player knocked out by Mercy adds a 250-point bonus; their set-aside cards are not scored.",
      "A selectable points mode must be introduced as a new versioned rules profile before these values affect a game.",
    ],
  },
] satisfies readonly RuleGuideScoringMode[];

const rulesGuide = {
  guideVersion: RULES_GUIDE_VERSION,
  rulesProfile: RULES_VERSION,
  title: "Open Shed rules guide",
  sourceNote:
    "An independently authored guide to Open Shed's versioned rules profile, adapted for deterministic online play. It is not an official rulebook.",
  facts: {
    minimumPlayers: 2,
    maximumPlayers: 6,
    startingHandSize: 7,
    deckSize: 168,
    mercyLimit: 25,
  },
  sections,
  cardFamilies,
  scoringModes,
} satisfies OpenShedRulesGuide;

export const OPEN_SHED_RULES_GUIDE = deepFreeze(rulesGuide);
export const RULES_GUIDE_SECTIONS: readonly RuleGuideSection[] =
  OPEN_SHED_RULES_GUIDE.sections;
export const RULES_GUIDE_CARD_FAMILIES: readonly RuleGuideCardFamily[] =
  OPEN_SHED_RULES_GUIDE.cardFamilies;
export const RULES_GUIDE_CARDS_BY_KIND: RuleGuideCardMap =
  deepFreeze(cardGuideByKind);
export const RULES_GUIDE_SCORING_MODES: readonly RuleGuideScoringMode[] =
  OPEN_SHED_RULES_GUIDE.scoringModes;
