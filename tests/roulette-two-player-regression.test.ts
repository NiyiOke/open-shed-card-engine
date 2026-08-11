import assert from "node:assert/strict";
import test from "node:test";
import {
  createLobbyState,
  joinLobbyState,
  transitionGame,
} from "../lib/game/engine";
import { assertGameInvariants } from "../lib/game/invariants";
import { projectGameForUser } from "../lib/game/projection";
import type {
  Card,
  GameCommand,
  GameState,
  TransitionResult,
} from "../lib/game/types";

const NEO = { userId: "user-neo", playerId: "player-neo", name: "Neo Oke" };
const KOLADE = {
  userId: "user-kolade",
  playerId: "player-kolade",
  name: "Kolade Aribaba",
};

test("two-player Color Roulette asks the target, then returns an actionable turn to its actor", () => {
  let state = startedTwoPlayerGame();
  state.currentPlayerId = NEO.playerId;
  state.pendingDraw = null;
  state.rouletteTargetId = null;
  state.forcedCardId = null;
  state.unoLiabilities = [];

  const roulette = takeCard(state, (card) => card.kind === "wild_color_roulette");
  const yellowSkipEveryone = takeCard(
    state,
    (card) => card.kind === "skip_everyone" && card.color === "yellow",
  );
  const yellowOne = takeCard(
    state,
    (card) => card.kind === "number" && card.color === "yellow" && card.number === 1,
  );
  const blueTwo = takeCard(
    state,
    (card) => card.kind === "number" && card.color === "blue" && card.number === 2,
  );
  replaceHand(state, NEO.playerId, [roulette, yellowSkipEveryone, yellowOne, blueTwo]);

  const revealed = [
    takeCard(
      state,
      (card) => card.kind === "number" && card.color === "yellow" && card.number === 4,
    ),
    takeCard(
      state,
      (card) => card.kind === "number" && card.color === "blue" && card.number === 5,
    ),
    takeCard(
      state,
      (card) => card.kind === "number" && card.color === "red" && card.number === 3,
    ),
  ];
  queueNextDraws(state, revealed);

  state = run(state, NEO.userId, {
    type: "play_card",
    cardId: roulette.id,
  }).state;

  const neoWaitingView = projectGameForUser(state, NEO.userId);
  const koladeChoiceView = projectGameForUser(state, KOLADE.userId);
  assert.equal(state.currentPlayerId, KOLADE.playerId);
  assert.equal(state.rouletteTargetId, KOLADE.playerId);
  assert.equal(neoWaitingView.legalActions.canChooseRouletteColor, false);
  assert.equal(neoWaitingView.legalActions.canDrawUntilPlayable, false);
  assert.equal(koladeChoiceView.legalActions.canChooseRouletteColor, true);
  assert.deepEqual(koladeChoiceView.legalActions.playableCardIds, []);

  const resolution = run(state, KOLADE.userId, {
    type: "choose_roulette_color",
    color: "red",
  });
  state = resolution.state;

  const neoActionView = projectGameForUser(state, NEO.userId);
  const koladeWaitingView = projectGameForUser(state, KOLADE.userId);
  assert.equal(state.rouletteTargetId, null);
  assert.equal(state.activeColor, "red");
  assert.equal(state.currentPlayerId, NEO.playerId);
  assert.equal(neoActionView.legalActions.canChooseRouletteColor, false);
  assert.deepEqual(neoActionView.legalActions.playableCardIds, []);
  assert.equal(neoActionView.legalActions.canDrawUntilPlayable, true);
  assert.equal(koladeWaitingView.legalActions.canChooseRouletteColor, false);
  assert.equal(koladeWaitingView.legalActions.canDrawUntilPlayable, false);
  assert.equal(resolution.events.at(-1)?.type, "roulette_resolved");
  assert.equal(
    resolution.events.at(-1)?.message,
    "Kolade Aribaba chose red and drew 3 cards.",
  );
  assertGameInvariants(state);
});

function startedTwoPlayerGame(): GameState {
  let state = createLobbyState({
    gameId: "roulette-two-player-regression",
    joinCode: "RLT2P1",
    hostUserId: NEO.userId,
    hostPlayerId: NEO.playerId,
    hostDisplayName: NEO.name,
    now: 1,
    seed: 20260811,
  });
  state = joinLobbyState(state, {
    userId: KOLADE.userId,
    playerId: KOLADE.playerId,
    displayName: KOLADE.name,
    commandId: "join-kolade",
    now: 2,
  }).state;
  state = run(state, NEO.userId, { type: "set_ready", ready: true }).state;
  state = run(state, KOLADE.userId, { type: "set_ready", ready: true }).state;
  return run(state, NEO.userId, { type: "start_game" }).state;
}

let commandSequence = 0;
function run(
  state: GameState,
  actorUserId: string,
  command: GameCommand,
): TransitionResult {
  commandSequence += 1;
  return transitionGame(state, command, {
    actorUserId,
    commandId: `roulette-command-${commandSequence}`,
    now: state.updatedAt + 1,
  });
}

function allCards(state: GameState): Card[] {
  return [
    ...state.drawPile,
    ...state.discardPile,
    ...state.mercyReserve,
    ...state.players.flatMap((player) => player.hand),
  ];
}

function takeCard(state: GameState, predicate: (card: Card) => boolean): Card {
  const card = allCards(state).find(predicate);
  if (!card) throw new Error("Fixture card was not found.");
  for (const zone of [
    state.drawPile,
    state.discardPile,
    state.mercyReserve,
    ...state.players.map((player) => player.hand),
  ]) {
    const index = zone.findIndex((candidate) => candidate.id === card.id);
    if (index >= 0) return zone.splice(index, 1)[0];
  }
  throw new Error(`Card ${card.id} was not found.`);
}

function replaceHand(state: GameState, playerId: string, cards: Card[]): void {
  const player = state.players.find((candidate) => candidate.playerId === playerId);
  if (!player) throw new Error(`Player ${playerId} was not found.`);
  state.drawPile.unshift(...player.hand);
  player.hand = cards;
}

function queueNextDraws(state: GameState, cardsInDrawOrder: Card[]): void {
  state.drawPile.push(...[...cardsInDrawOrder].reverse());
}
