import { cardLabel, colorLabel } from "./deck";
import type { Card, CardColor, CardKind } from "./types";

export type CardIconKey =
  | "aperture"
  | "cards"
  | "reverse"
  | "skip"
  | "skip_all";

export type CardPresentation = {
  accessibleName: string;
  activeWildColor: CardColor | null;
  centerMark: string | null;
  color: CardColor | "wild";
  cornerMark: string;
  icon: CardIconKey | null;
  label: string;
  supportMark: string | null;
};

type ActionPresentation = Omit<
  CardPresentation,
  "accessibleName" | "activeWildColor" | "color"
>;

const ACTION_PRESENTATION = {
  draw_two: {
    centerMark: "+2",
    cornerMark: "+2",
    icon: null,
    label: "Draw 2",
    supportMark: null,
  },
  draw_four: {
    centerMark: "+4",
    cornerMark: "+4",
    icon: null,
    label: "Draw 4",
    supportMark: null,
  },
  skip: {
    centerMark: null,
    cornerMark: "SKIP",
    icon: "skip",
    label: "Skip",
    supportMark: null,
  },
  reverse: {
    centerMark: null,
    cornerMark: "REV",
    icon: "reverse",
    label: "Reverse",
    supportMark: null,
  },
  discard_all: {
    centerMark: null,
    cornerMark: "ALL",
    icon: "cards",
    label: "Discard all",
    supportMark: null,
  },
  skip_everyone: {
    centerMark: null,
    cornerMark: "ALL",
    icon: "skip_all",
    label: "Skip everyone",
    supportMark: null,
  },
  wild_reverse_draw_four: {
    centerMark: null,
    cornerMark: "+4",
    icon: "reverse",
    label: "Reverse draw 4",
    supportMark: null,
  },
  wild_draw_six: {
    centerMark: "+6",
    cornerMark: "+6",
    icon: null,
    label: "Draw 6",
    supportMark: null,
  },
  wild_draw_ten: {
    centerMark: "+10",
    cornerMark: "+10",
    icon: null,
    label: "Draw 10",
    supportMark: null,
  },
  wild_color_roulette: {
    centerMark: null,
    cornerMark: "WILD",
    icon: "aperture",
    label: "Color roulette",
    supportMark: null,
  },
} satisfies Record<Exclude<CardKind, "number">, ActionPresentation>;

export function getCardPresentation(
  card: Card,
  activeWildColor: CardColor | null = null,
): CardPresentation {
  const color = card.color ?? "wild";
  const activeColor = card.color === null ? activeWildColor : null;
  const activeColorCopy = activeColor
    ? ` ${colorLabel(activeColor)} is active.`
    : "";

  if (card.kind === "number") {
    const number = String(card.number);
    return {
      accessibleName: `${cardLabel(card)}.${activeColorCopy}`.trim(),
      activeWildColor: activeColor,
      centerMark: number,
      color,
      cornerMark: number,
      icon: null,
      label: "Number",
      supportMark: null,
    };
  }

  return {
    ...ACTION_PRESENTATION[card.kind],
    accessibleName: `${cardLabel(card)}.${activeColorCopy}`.trim(),
    activeWildColor: activeColor,
    color,
  };
}
