import { GameRuleError } from "./errors";
import type { Card, GameState } from "./types";

export function assertGameInvariants(state: GameState): void {
  const cards: Card[] = [
    ...state.drawPile,
    ...state.discardPile,
    ...state.mercyReserve,
    ...state.players.flatMap((player) => player.hand),
  ];
  const ids = new Set(cards.map((card) => card.id));

  // An abandoned lobby may be closed before any deck exists. Once dealing has
  // begun, every terminal and active state must conserve the physical deck.
  if (state.dealerSeat !== null && cards.length !== 168) {
    throw new GameRuleError(
      "CARD_CONSERVATION_FAILED",
      `Expected 168 cards across all zones, found ${cards.length}.`,
      500,
    );
  }
  if (ids.size !== cards.length) {
    throw new GameRuleError(
      "DUPLICATE_CARD",
      "A physical card appears in more than one game zone.",
      500,
    );
  }
  if (state.phase === "playing") {
    if (state.discardPile.length === 0) {
      throw new GameRuleError(
        "MISSING_DISCARD",
        "An active game must have a visible discard.",
        500,
      );
    }
    const current = state.players.find(
      (player) => player.playerId === state.currentPlayerId,
    );
    if (!current || current.status !== "active") {
      throw new GameRuleError(
        "INVALID_CURRENT_PLAYER",
        "The current turn must belong to an active player.",
        500,
      );
    }
    if (
      state.forcedCardId &&
      !current.hand.some((card) => card.id === state.forcedCardId)
    ) {
      throw new GameRuleError(
        "INVALID_FORCED_CARD",
        "A forced card must belong to the current active player.",
        500,
      );
    }
    for (const player of state.players) {
      if (player.status === "active" && player.hand.length >= 25) {
        throw new GameRuleError(
          "MERCY_INVARIANT_FAILED",
          "An active player cannot keep 25 or more cards.",
          500,
        );
      }
    }
  }
}
