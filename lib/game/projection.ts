import { drawValue } from "./deck";
import { isNormallyPlayable } from "./engine";
import type { GameState, GameView, LegalActions, PlayerState } from "./types";

export function projectGameForUser(
  state: GameState,
  viewerUserId: string,
): GameView {
  const viewer = state.players.find((player) => player.userId === viewerUserId);
  if (!viewer) throw new Error("Viewer is not a member of this game.");

  const current = state.players.find(
    (player) => player.playerId === state.currentPlayerId,
  );
  const winnerPlayer = state.players.find(
    (player) => player.playerId === state.winner?.playerId,
  );

  return {
    gameId: state.gameId,
    joinCode: state.joinCode,
    phase: state.phase,
    rulesVersion: state.rules.version,
    revision: state.revision,
    turnNumber: state.turnNumber,
    direction: state.direction,
    activeColor: state.activeColor,
    currentPlayerId: state.currentPlayerId,
    currentPlayerName: current?.displayName ?? null,
    topDiscard: state.discardPile.at(-1) ?? null,
    drawPileCount: state.drawPile.length,
    mercyReserveCount: state.mercyReserve.length,
    pendingDraw: state.pendingDraw,
    rouletteTargetId: state.rouletteTargetId,
    // A physical card ID encodes its face. Only its owner may learn a card
    // drawn by the forced-draw flow.
    forcedCardId:
      state.currentPlayerId === viewer.playerId ? state.forcedCardId : null,
    unoLiabilities: state.unoLiabilities,
    winner:
      state.winner && winnerPlayer
        ? { ...state.winner, displayName: winnerPlayer.displayName }
        : null,
    players: state.players.map((player) => ({
      playerId: player.playerId,
      displayName: player.displayName,
      seat: player.seat,
      ready: player.ready,
      status: player.status,
      knockedOutBy: player.knockedOutBy,
      cardCount: player.hand.length,
      isSelf: player.userId === viewerUserId,
    })),
    hand: viewer.hand,
    legalActions: legalActionsFor(state, viewer),
    isHost: state.hostUserId === viewerUserId,
  };
}

export function legalActionsFor(
  state: GameState,
  viewer: PlayerState,
): LegalActions {
  const isTurn =
    state.phase === "playing" &&
    viewer.status === "active" &&
    state.currentPlayerId === viewer.playerId;
  const playableCardIds: string[] = [];

  if (isTurn && state.rouletteTargetId === null) {
    if (state.pendingDraw) {
      for (const card of viewer.hand) {
        const value = drawValue(card);
        if (value !== null && value >= state.pendingDraw.minimum) {
          playableCardIds.push(card.id);
        }
      }
    } else if (state.forcedCardId) {
      playableCardIds.push(state.forcedCardId);
    } else {
      for (const card of viewer.hand) {
        if (isNormallyPlayable(state, card)) playableCardIds.push(card.id);
      }
    }
  }

  return {
    canSetReady: state.phase === "lobby" && viewer.status === "active",
    canStart:
      state.phase === "lobby" &&
      state.hostUserId === viewer.userId &&
      state.players.filter((player) => player.status === "active").length >= 2 &&
      state.players
        .filter((player) => player.status === "active")
        .every((player) => player.ready),
    playableCardIds,
    canDrawUntilPlayable:
      isTurn &&
      !state.pendingDraw &&
      !state.rouletteTargetId &&
      !state.forcedCardId &&
      playableCardIds.length === 0,
    canAcceptPenalty: isTurn && state.pendingDraw !== null,
    canChooseRouletteColor:
      isTurn && state.rouletteTargetId === viewer.playerId,
    canDeclareUno: state.unoLiabilities.some(
      (entry) => entry.playerId === viewer.playerId,
    ),
    catchablePlayerIds: state.unoLiabilities
      .filter((entry) => entry.playerId !== viewer.playerId)
      .map((entry) => entry.playerId),
    canRematch:
      state.phase === "complete" &&
      state.hostUserId === viewer.userId &&
      viewer.status !== "left",
    canLeave: viewer.status !== "left",
  };
}
