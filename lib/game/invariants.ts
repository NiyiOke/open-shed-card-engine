import { GameRuleError } from "./errors";
import type { Card, GameState } from "./types";

export function assertGameInvariants(state: GameState): void {
  const host = state.players.find(
    (player) => player.userId === state.hostUserId,
  );
  if (!host) {
    throw new GameRuleError(
      "INVALID_HOST",
      "The table host must be a member of the game.",
      500,
    );
  }
  if (
    host.status === "left" &&
    state.players.some((player) => player.status !== "left")
  ) {
    throw new GameRuleError(
      "INVALID_HOST",
      "A table with current members must have a current host.",
      500,
    );
  }

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
  for (const player of state.players) {
    if (player.status === "left" && player.hand.length > 0) {
      throw new GameRuleError(
        "LEFT_PLAYER_HAS_CARDS",
        "A departed player cannot retain cards.",
        500,
      );
    }
  }
  if (
    state.players.every((player) => player.status === "left") &&
    state.phase !== "complete"
  ) {
    throw new GameRuleError(
      "EMPTY_ROOM_NOT_COMPLETE",
      "A table without current members must be terminal.",
      500,
    );
  }
  if (
    state.phase === "complete" &&
    (state.currentPlayerId !== null ||
      state.pendingDraw !== null ||
      state.rouletteTargetId !== null ||
      state.forcedCardId !== null ||
      state.unoLiabilities.length > 0)
  ) {
    throw new GameRuleError(
      "TERMINAL_TRANSIENT_STATE",
      "A completed table cannot retain turn-owned transient state.",
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
