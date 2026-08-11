import { cardLabel, createDeck, drawValue, isActionCard, isWild } from "./deck";
import { GameRuleError, requireRule } from "./errors";
import { assertGameInvariants } from "./invariants";
import { shuffleInPlace } from "./random";
import {
  BASELINE_RULES,
  COLORS,
  GAME_PROTOCOL_VERSION,
  type Card,
  type CardColor,
  type GameCommand,
  type GameEvent,
  type GameState,
  type PlayerState,
  type TransitionContext,
  type TransitionResult,
} from "./types";

type CreateLobbyInput = {
  gameId: string;
  joinCode: string;
  hostUserId: string;
  hostPlayerId: string;
  hostDisplayName: string;
  now: number;
  seed?: number;
};

type JoinLobbyInput = {
  userId: string;
  playerId: string;
  displayName: string;
  commandId: string;
  now: number;
};

export function createLobbyState(input: CreateLobbyInput): GameState {
  return {
    schemaVersion: 1,
    protocolVersion: GAME_PROTOCOL_VERSION,
    rules: BASELINE_RULES,
    gameId: input.gameId,
    joinCode: input.joinCode,
    hostUserId: input.hostUserId,
    phase: "lobby",
    players: [
      createPlayer(
        input.hostPlayerId,
        input.hostUserId,
        input.hostDisplayName,
        0,
      ),
    ],
    dealerSeat: null,
    currentPlayerId: null,
    direction: 1,
    activeColor: null,
    drawPile: [],
    discardPile: [],
    mercyReserve: [],
    pendingDraw: null,
    rouletteTargetId: null,
    forcedCardId: null,
    unoLiabilities: [],
    winner: null,
    revision: 0,
    turnNumber: 0,
    // Public room identifiers must never determine the private deck order.
    // Tests may inject a numeric seed; production uses Web Crypto (`null`).
    rngState: input.seed ?? null,
    processedCommands: [],
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function joinLobbyState(
  original: GameState,
  input: JoinLobbyInput,
): TransitionResult {
  const existing = original.players.find(
    (player) => player.userId === input.userId,
  );
  if (existing?.status === "active") {
    return { state: original, events: [], replayed: true };
  }

  requireRule(
    original.phase === "lobby",
    "GAME_ALREADY_STARTED",
    "This game has already started.",
    409,
  );
  requireRule(
    activePlayers(original).length < 6,
    "LOBBY_FULL",
    "This lobby already has six players.",
    409,
  );

  const state = cloneState(original);
  let joined: PlayerState;
  const returning = state.players.find((player) => player.userId === input.userId);
  if (returning) {
    returning.status = "active";
    returning.ready = false;
    returning.displayName = cleanDisplayName(input.displayName);
    returning.knockedOutBy = null;
    joined = returning;
  } else {
    // Departed lobby placeholders exist only long enough to acknowledge their
    // leave command. Remove them before assigning a reusable stable seat.
    state.players = state.players.filter((player) => player.status === "active");
    const usedSeats = new Set(state.players.map((player) => player.seat));
    let seat = 0;
    while (usedSeats.has(seat)) seat += 1;
    joined = createPlayer(input.playerId, input.userId, input.displayName, seat);
    state.players.push(joined);
  }
  state.players.sort((left, right) => left.seat - right.seat);
  state.revision += 1;
  state.updatedAt = input.now;
  rememberCommand(state, input.userId, input.commandId);

  const event: GameEvent = {
    type: "player_joined",
    actorPlayerId: joined.playerId,
    message: `${joined.displayName} ${returning ? "rejoined" : "joined"} the lobby.`,
  };
  return { state, events: [event], replayed: false };
}

export function transitionGame(
  original: GameState,
  command: GameCommand,
  context: TransitionContext,
): TransitionResult {
  if (
    original.processedCommands.some(
      (entry) =>
        entry.actorUserId === context.actorUserId &&
        entry.commandId === context.commandId,
    )
  ) {
    return { state: original, events: [], replayed: true };
  }

  const state = cloneState(original);
  const actor = state.players.find(
    (player) => player.userId === context.actorUserId,
  );
  requireRule(actor, "NOT_A_MEMBER", "You are not a member of this game.", 403);
  if (command.type !== "rematch") {
    requireRule(
      state.phase !== "complete",
      "GAME_COMPLETE",
      "This game is complete and no longer accepts commands.",
      409,
    );
  }

  const events: GameEvent[] = [];
  switch (command.type) {
    case "set_ready":
      setReady(state, actor, command.ready, events);
      break;
    case "start_game":
      startGame(state, actor, events);
      break;
    case "declare_uno":
      declareUno(state, actor, events);
      break;
    case "catch_uno":
      catchUno(state, actor, command.offenderPlayerId, events);
      break;
    case "rematch":
      startRematchLobby(state, actor, events);
      break;
    case "remove_inactive_player":
      removeInactivePlayer(state, actor, command.targetPlayerId, events);
      break;
    case "leave_game":
      leaveGame(state, actor, events);
      break;
    default:
      requirePlayingTurn(state, actor);
      closeUnoReactionWindow(state);
      if (command.type === "play_card") {
        playCard(state, actor, command, events);
      } else if (command.type === "draw_until_playable") {
        drawUntilPlayable(state, actor, events);
      } else if (command.type === "accept_penalty") {
        acceptPenalty(state, actor, events);
      } else if (command.type === "choose_roulette_color") {
        chooseRouletteColor(state, actor, command.color, events);
      }
      break;
  }

  state.revision += 1;
  state.updatedAt = context.now;
  rememberCommand(state, context.actorUserId, context.commandId);
  assertGameInvariants(state);
  return { state, events, replayed: false };
}

export function isNormallyPlayable(state: GameState, card: Card): boolean {
  if (isWild(card)) return true;
  const top = state.discardPile.at(-1);
  if (!top) return false;
  if (card.color === state.activeColor) return true;
  if (card.kind === "number" && top.kind === "number") {
    return card.number === top.number;
  }
  return card.kind !== "number" && card.kind === top.kind;
}

export function activePlayers(state: GameState): PlayerState[] {
  return state.players
    .filter((player) => player.status === "active")
    .sort((left, right) => left.seat - right.seat);
}

export function nextActivePlayer(
  state: GameState,
  fromPlayerId: string,
  steps = 1,
  direction = state.direction,
): PlayerState {
  const origin = state.players.find(
    (player) => player.playerId === fromPlayerId,
  );
  if (!origin) throw new GameRuleError("PLAYER_NOT_FOUND", "Player not found.", 500);

  const ordered = [...state.players].sort((left, right) => left.seat - right.seat);
  let index = ordered.findIndex((player) => player.playerId === origin.playerId);
  let remaining = steps;
  for (let guard = 0; guard < ordered.length * (steps + 2); guard += 1) {
    index = (index + direction + ordered.length) % ordered.length;
    const candidate = ordered[index];
    if (candidate.status !== "active") continue;
    remaining -= 1;
    if (remaining === 0) return candidate;
  }
  throw new GameRuleError(
    "NO_ACTIVE_PLAYER",
    "No active player is available for the next turn.",
    500,
  );
}

function createPlayer(
  playerId: string,
  userId: string,
  displayName: string,
  seat: number,
): PlayerState {
  return {
    playerId,
    userId,
    displayName: cleanDisplayName(displayName),
    seat,
    ready: false,
    status: "active",
    hand: [],
    knockedOutBy: null,
  };
}

function setReady(
  state: GameState,
  actor: PlayerState,
  ready: boolean,
  events: GameEvent[],
): void {
  requireRule(state.phase === "lobby", "NOT_IN_LOBBY", "The lobby is closed.");
  requireRule(actor.status === "active", "PLAYER_NOT_ACTIVE", "You already left this lobby.");
  actor.ready = Boolean(ready);
  events.push({
    type: "ready_changed",
    actorPlayerId: actor.playerId,
    message: `${actor.displayName} is ${actor.ready ? "ready" : "not ready"}.`,
    data: { ready: actor.ready },
  });
}

function startGame(
  state: GameState,
  actor: PlayerState,
  events: GameEvent[],
): void {
  requireRule(state.phase === "lobby", "NOT_IN_LOBBY", "The game has started.");
  requireRule(
    actor.userId === state.hostUserId,
    "HOST_ONLY",
    "Only the host can start the game.",
    403,
  );
  const participants = activePlayers(state);
  requireRule(
    participants.length >= 2 && participants.length <= 6,
    "PLAYER_COUNT",
    "A game needs between two and six players.",
  );
  requireRule(
    participants.every((player) => player.ready),
    "PLAYERS_NOT_READY",
    "Every player must be ready before the game starts.",
  );

  state.players = participants;
  state.phase = "playing";
  state.direction = 1;
  state.dealerSeat = actor.seat;
  state.drawPile = createDeck();
  state.rngState = shuffleInPlace(state.drawPile, state.rngState);

  const seats = [...state.players].sort((left, right) => left.seat - right.seat);
  for (let round = 0; round < 7; round += 1) {
    for (const player of seats) {
      const card = state.drawPile.pop();
      if (!card) throw new GameRuleError("DECK_EXHAUSTED", "Deck exhausted.", 500);
      player.hand.push(card);
    }
  }

  while (true) {
    const opening = state.drawPile.pop();
    if (!opening) {
      throw new GameRuleError("DECK_EXHAUSTED", "No opening number card.", 500);
    }
    state.discardPile.push(opening);
    if (!isActionCard(opening)) {
      state.activeColor = opening.color;
      break;
    }
  }

  state.currentPlayerId = nextActivePlayer(state, actor.playerId).playerId;
  state.turnNumber = 1;
  events.push({
    type: "game_started",
    actorPlayerId: actor.playerId,
    message: `${actor.displayName} started the game.`,
  });
}

function requirePlayingTurn(state: GameState, actor: PlayerState): void {
  requireRule(state.phase === "playing", "GAME_NOT_ACTIVE", "The game is not active.");
  requireRule(actor.status === "active", "PLAYER_NOT_ACTIVE", "You are not active.", 403);
  requireRule(
    state.currentPlayerId === actor.playerId,
    "NOT_YOUR_TURN",
    "Wait for your turn.",
    409,
  );
}

function playCard(
  state: GameState,
  actor: PlayerState,
  command: Extract<GameCommand, { type: "play_card" }>,
  events: GameEvent[],
): void {
  requireRule(
    state.rouletteTargetId === null,
    "ROULETTE_CHOICE_REQUIRED",
    "Choose the roulette color before continuing.",
  );

  const cardIndex = actor.hand.findIndex((card) => card.id === command.cardId);
  requireRule(cardIndex >= 0, "CARD_NOT_IN_HAND", "That card is not in your hand.");
  const card = actor.hand[cardIndex];

  if (state.pendingDraw) {
    const value = drawValue(card);
    requireRule(
      value !== null && value >= state.pendingDraw.minimum,
      "INVALID_STACK",
      `Stack a draw card worth ${state.pendingDraw.minimum} or more, or accept the penalty.`,
    );
  } else {
    requireRule(
      !state.forcedCardId || state.forcedCardId === card.id,
      "FORCED_CARD_REQUIRED",
      "You must play the card you just drew.",
    );
    requireRule(
      isNormallyPlayable(state, card),
      "CARD_NOT_PLAYABLE",
      "That card does not match the active color, number, or symbol.",
    );
  }

  validateCardChoices(state, actor, card, command.chosenColor, command.swapTargetId);
  const handSizesBeforePlay = new Map(
    state.players.map((player) => [player.playerId, player.hand.length]),
  );
  actor.hand.splice(cardIndex, 1);
  state.forcedCardId = null;

  if (card.kind === "discard_all") {
    const extras = actor.hand.filter((candidate) => candidate.color === card.color);
    actor.hand = actor.hand.filter((candidate) => candidate.color !== card.color);
    state.discardPile.push(...extras, card);
    events.push({
      type: "discard_all",
      actorPlayerId: actor.playerId,
      message: `${actor.displayName} discarded ${extras.length + 1} ${card.color} cards.`,
      data: { count: extras.length + 1 },
    });
  } else {
    state.discardPile.push(card);
  }

  if (card.color) state.activeColor = card.color;
  if (isWild(card) && card.kind !== "wild_color_roulette") {
    state.activeColor = command.chosenColor ?? null;
  }

  events.push({
    type: "card_played",
    actorPlayerId: actor.playerId,
    message: `${actor.displayName} played ${cardLabel(card)}.`,
    data: { cardId: card.id, cardKind: card.kind },
  });

  // The rules profile follows the literal paper rule: playing the final card wins
  // before effects that target another hand. Discard All is part of the actor's play.
  if (actor.hand.length === 0) {
    completeGame(state, actor, "empty_hand", events);
    return;
  }

  if (state.pendingDraw) {
    resolveDrawCard(state, actor, card, events, state.pendingDraw.total);
  } else {
    resolveOrdinaryCard(state, actor, card, command.swapTargetId, events);
  }

  if (state.phase !== "playing") return;
  refreshUnoLiabilities(
    state,
    command.declareUno ? actor.playerId : null,
    handSizesBeforePlay,
    events,
  );
  state.turnNumber += 1;
}

function validateCardChoices(
  state: GameState,
  actor: PlayerState,
  card: Card,
  chosenColor?: CardColor,
  swapTargetId?: string,
): void {
  if (isWild(card) && card.kind !== "wild_color_roulette") {
    requireRule(
      chosenColor && COLORS.includes(chosenColor),
      "COLOR_REQUIRED",
      "Choose the continuing color for this Wild card.",
    );
  }
  if (card.kind === "number" && card.number === 7) {
    const target = state.players.find(
      (player) => player.playerId === swapTargetId,
    );
    requireRule(
      target && target.status === "active" && target.playerId !== actor.playerId,
      "SWAP_TARGET_REQUIRED",
      "Choose another active player for the mandatory hand swap.",
    );
  }
}

function resolveOrdinaryCard(
  state: GameState,
  actor: PlayerState,
  card: Card,
  swapTargetId: string | undefined,
  events: GameEvent[],
): void {
  if (card.kind === "number" && card.number === 0) {
    rotateHands(state);
    state.currentPlayerId = nextActivePlayer(state, actor.playerId).playerId;
    events.push({
      type: "hands_rotated",
      actorPlayerId: actor.playerId,
      message: `Every hand moved ${state.direction === 1 ? "clockwise" : "counterclockwise"}.`,
    });
    return;
  }

  if (card.kind === "number" && card.number === 7) {
    const target = state.players.find(
      (player) => player.playerId === swapTargetId,
    );
    if (!target) throw new GameRuleError("SWAP_TARGET_REQUIRED", "Target missing.");
    [actor.hand, target.hand] = [target.hand, actor.hand];
    state.currentPlayerId = nextActivePlayer(state, actor.playerId).playerId;
    events.push({
      type: "hands_swapped",
      actorPlayerId: actor.playerId,
      message: `${actor.displayName} swapped hands with ${target.displayName}.`,
      data: { targetPlayerId: target.playerId },
    });
    return;
  }

  switch (card.kind) {
    case "draw_two":
    case "draw_four":
    case "wild_draw_six":
    case "wild_draw_ten":
    case "wild_reverse_draw_four":
      resolveDrawCard(state, actor, card, events, 0);
      break;
    case "skip":
      state.currentPlayerId = nextActivePlayer(state, actor.playerId, 2).playerId;
      break;
    case "reverse":
      state.direction = state.direction === 1 ? -1 : 1;
      state.currentPlayerId =
        activePlayers(state).length === 2
          ? actor.playerId
          : nextActivePlayer(state, actor.playerId).playerId;
      break;
    case "skip_everyone":
      state.currentPlayerId = actor.playerId;
      break;
    case "wild_color_roulette":
      state.rouletteTargetId = nextActivePlayer(state, actor.playerId).playerId;
      state.currentPlayerId = state.rouletteTargetId;
      break;
    default:
      state.currentPlayerId = nextActivePlayer(state, actor.playerId).playerId;
      break;
  }
}

function resolveDrawCard(
  state: GameState,
  actor: PlayerState,
  card: Card,
  events: GameEvent[],
  existingTotal: number,
): void {
  const value = drawValue(card);
  if (!value) throw new GameRuleError("NOT_A_DRAW_CARD", "Expected a draw card.", 500);

  if (card.kind === "wild_reverse_draw_four") {
    state.direction = state.direction === 1 ? -1 : 1;
  }

  const target =
    card.kind === "wild_reverse_draw_four" && activePlayers(state).length === 2
      ? actor
      : nextActivePlayer(state, actor.playerId);

  state.pendingDraw = {
    total: existingTotal + value,
    minimum: value,
    sourcePlayerId: actor.playerId,
  };
  state.currentPlayerId = target.playerId;
  events.push({
    type: "draw_penalty_stacked",
    actorPlayerId: actor.playerId,
    message: `${target.displayName} now faces a draw ${state.pendingDraw.total} penalty.`,
    data: { total: state.pendingDraw.total, minimum: value },
  });
}

function drawUntilPlayable(
  state: GameState,
  actor: PlayerState,
  events: GameEvent[],
): void {
  requireRule(!state.pendingDraw, "PENALTY_PENDING", "Resolve the draw penalty first.");
  requireRule(
    state.rouletteTargetId === null,
    "ROULETTE_CHOICE_REQUIRED",
    "Choose a roulette color first.",
  );
  requireRule(!state.forcedCardId, "FORCED_CARD_REQUIRED", "Play the card you drew.");
  requireRule(
    !actor.hand.some((card) => isNormallyPlayable(state, card)),
    "PLAYABLE_CARD_AVAILABLE",
    "You already have a playable card.",
  );

  let count = 0;
  while (state.phase === "playing") {
    const card = drawOne(state);
    actor.hand.push(card);
    count += 1;
    if (actor.hand.length >= 25) {
      eliminatePlayer(state, actor, null, events);
      repairTurnAfterRemoval(state, actor, events);
      break;
    }
    if (isNormallyPlayable(state, card)) {
      state.forcedCardId = card.id;
      break;
    }
  }

  events.push({
    type: "cards_drawn_until_playable",
    actorPlayerId: actor.playerId,
    message:
      state.phase === "playing" && actor.status === "active"
        ? `${actor.displayName} drew ${count} card${count === 1 ? "" : "s"} and must play the match.`
        : `${actor.displayName} reached the Mercy limit while drawing.`,
    data: { count },
  });
}

function acceptPenalty(
  state: GameState,
  actor: PlayerState,
  events: GameEvent[],
): void {
  requireRule(state.pendingDraw, "NO_DRAW_PENALTY", "There is no draw penalty to accept.");
  const total = state.pendingDraw.total;
  const source = state.pendingDraw.sourcePlayerId;
  state.pendingDraw = null;
  drawCardsWithImmediateMercy(state, actor, total, source, events);

  if (state.phase === "playing") {
    state.currentPlayerId = nextActivePlayer(state, actor.playerId).playerId;
    state.turnNumber += 1;
  }
  events.push({
    type: "draw_penalty_accepted",
    actorPlayerId: actor.playerId,
    message: `${actor.displayName} accepted a draw ${total} penalty.`,
    data: { total },
  });
}

function chooseRouletteColor(
  state: GameState,
  actor: PlayerState,
  color: CardColor,
  events: GameEvent[],
): void {
  requireRule(
    state.rouletteTargetId === actor.playerId,
    "NOT_ROULETTE_TARGET",
    "Only the targeted player can choose the roulette color.",
  );
  requireRule(COLORS.includes(color), "INVALID_COLOR", "Choose a valid color.");

  const revealed: Card[] = [];
  while (true) {
    let card: Card;
    try {
      card = drawOne(state);
    } catch (error) {
      if (error instanceof GameRuleError && error.code === "DECK_EXHAUSTED") break;
      throw error;
    }
    revealed.push(card);
    if (card.color === color) break;
  }

  actor.hand.push(...revealed);
  state.activeColor = color;
  state.rouletteTargetId = null;
  if (actor.hand.length >= 25) {
    eliminatePlayer(state, actor, null, events);
    repairTurnAfterRemoval(state, actor, events);
  } else {
    state.currentPlayerId = nextActivePlayer(state, actor.playerId).playerId;
  }
  state.turnNumber += 1;
  events.push({
    type: "roulette_resolved",
    actorPlayerId: actor.playerId,
    message: `${actor.displayName} chose ${color} and drew ${revealed.length} card${revealed.length === 1 ? "" : "s"}.`,
    data: { color, count: revealed.length },
  });
}

function declareUno(
  state: GameState,
  actor: PlayerState,
  events: GameEvent[],
): void {
  requireRule(state.phase === "playing", "GAME_NOT_ACTIVE", "The game is not active.");
  requireRule(actor.status === "active", "PLAYER_NOT_ACTIVE", "You are not active.", 403);
  const liability = state.unoLiabilities.find(
    (entry) => entry.playerId === actor.playerId,
  );
  requireRule(liability, "UNO_NOT_REQUIRED", "You do not currently need to call UNO.");
  state.unoLiabilities = state.unoLiabilities.filter(
    (entry) => entry.playerId !== actor.playerId,
  );
  events.push({
    type: "uno_declared",
    actorPlayerId: actor.playerId,
    message: `${actor.displayName} called UNO.`,
  });
}

function catchUno(
  state: GameState,
  actor: PlayerState,
  offenderPlayerId: string,
  events: GameEvent[],
): void {
  requireRule(state.phase === "playing", "GAME_NOT_ACTIVE", "The game is not active.");
  requireRule(actor.status === "active", "PLAYER_NOT_ACTIVE", "You are not active.", 403);
  requireRule(
    actor.playerId !== offenderPlayerId,
    "CANNOT_CATCH_SELF",
    "Call UNO for yourself instead.",
  );
  const offender = state.players.find(
    (player) => player.playerId === offenderPlayerId,
  );
  requireRule(
    offender &&
      offender.status === "active" &&
      state.unoLiabilities.some((entry) => entry.playerId === offender.playerId),
    "UNO_WINDOW_CLOSED",
    "That UNO reaction window is closed.",
    409,
  );

  state.unoLiabilities = state.unoLiabilities.filter(
    (entry) => entry.playerId !== offender.playerId,
  );
  drawCardsWithImmediateMercy(state, offender, 2, actor.playerId, events);
  events.push({
    type: "uno_caught",
    actorPlayerId: actor.playerId,
    message: `${actor.displayName} caught ${offender.displayName}; ${offender.displayName} draws 2.`,
    data: { offenderPlayerId },
  });
}

function leaveGame(
  state: GameState,
  actor: PlayerState,
  events: GameEvent[],
): void {
  removePlayer(state, actor, events);
  events.push({
    type: "player_left",
    actorPlayerId: actor.playerId,
    message: `${actor.displayName} left the game.`,
  });
}

function removeInactivePlayer(
  state: GameState,
  actor: PlayerState,
  targetPlayerId: string,
  events: GameEvent[],
): void {
  requireRule(
    state.phase === "lobby" || state.phase === "playing",
    "GAME_NOT_ACTIVE",
    "Inactive players can only be removed from a lobby or active game.",
  );
  requireRule(
    actor.userId === state.hostUserId,
    "HOST_ONLY",
    "Only the host can remove an inactive player.",
    403,
  );
  requireRule(
    actor.status === "active",
    "PLAYER_NOT_ACTIVE",
    "Only an active host can remove a player.",
    403,
  );
  requireRule(
    actor.playerId !== targetPlayerId,
    "CANNOT_REMOVE_SELF",
    "The host cannot remove themselves.",
  );
  const target = state.players.find(
    (player) => player.playerId === targetPlayerId,
  );
  requireRule(target, "PLAYER_NOT_FOUND", "That player is not in this game.", 404);
  requireRule(
    target.status === "active",
    "PLAYER_NOT_ACTIVE",
    "That player is no longer active.",
    409,
  );

  removePlayer(state, target, events);
  events.push({
    type: "inactive_player_removed",
    actorPlayerId: actor.playerId,
    message: `${actor.displayName} removed inactive player ${target.displayName}.`,
    data: { targetPlayerId: target.playerId },
  });
}

function removePlayer(
  state: GameState,
  player: PlayerState,
  events: GameEvent[],
): void {
  if (state.phase === "lobby") {
    player.status = "left";
    player.ready = false;
    const remaining = activePlayers(state);
    if (player.userId === state.hostUserId && remaining.length > 0) {
      state.hostUserId = remaining[0].userId;
    }
    if (remaining.length === 0) {
      state.phase = "complete";
    }
  } else if (state.phase === "playing") {
    const ownedForcedCard = player.hand.some((card) => card.id === state.forcedCardId);
    state.mercyReserve.push(...player.hand);
    player.hand = [];
    player.status = "left";
    player.ready = false;
    if (state.currentPlayerId === player.playerId) {
      state.pendingDraw = null;
      state.rouletteTargetId = null;
      state.forcedCardId = null;
    } else if (ownedForcedCard) {
      state.forcedCardId = null;
    }
    state.unoLiabilities = state.unoLiabilities.filter(
      (entry) => entry.playerId !== player.playerId,
    );
    repairTurnAfterRemoval(state, player, events);
  }
}

function startRematchLobby(
  state: GameState,
  actor: PlayerState,
  events: GameEvent[],
): void {
  requireRule(
    state.phase === "complete",
    "REMATCH_NOT_AVAILABLE",
    "A rematch is available only after the game is complete.",
    409,
  );
  requireRule(
    actor.userId === state.hostUserId,
    "HOST_ONLY",
    "Only the host can start a rematch.",
    403,
  );
  requireRule(
    actor.status !== "left",
    "PLAYER_NOT_ACTIVE",
    "A host who left the room cannot start a rematch.",
    403,
  );

  state.players = state.players
    .filter((player) => player.status !== "left")
    .sort((left, right) => left.seat - right.seat);
  for (const player of state.players) {
    player.ready = false;
    player.status = "active";
    player.hand = [];
    player.knockedOutBy = null;
  }
  state.phase = "lobby";
  state.dealerSeat = null;
  state.currentPlayerId = null;
  state.direction = 1;
  state.activeColor = null;
  state.drawPile = [];
  state.discardPile = [];
  state.mercyReserve = [];
  state.pendingDraw = null;
  state.rouletteTargetId = null;
  state.forcedCardId = null;
  state.unoLiabilities = [];
  state.winner = null;
  state.turnNumber = 0;
  events.push({
    type: "rematch_started",
    actorPlayerId: actor.playerId,
    message: `${actor.displayName} opened a rematch lobby.`,
  });
}

function rotateHands(state: GameState): void {
  const players = activePlayers(state);
  const snapshots = new Map(
    players.map((player) => [player.playerId, [...player.hand]]),
  );
  for (const player of players) {
    const recipient = nextActivePlayer(state, player.playerId);
    recipient.hand = snapshots.get(player.playerId) ?? [];
  }
}

function refreshUnoLiabilities(
  state: GameState,
  declaredPlayerId: string | null,
  handSizesBeforePlay: Map<string, number>,
  events: GameEvent[],
): void {
  state.unoLiabilities = [];
  for (const player of activePlayers(state)) {
    const newlyAtOne =
      player.hand.length === 1 && handSizesBeforePlay.get(player.playerId) !== 1;
    if (!newlyAtOne || player.playerId === declaredPlayerId) continue;
    state.unoLiabilities.push({
      playerId: player.playerId,
      openedRevision: state.revision + 1,
    });
  }
  if (declaredPlayerId) {
    state.unoLiabilities = state.unoLiabilities.filter(
      (entry) => entry.playerId !== declaredPlayerId,
    );
    const declared = state.players.find(
      (player) => player.playerId === declaredPlayerId,
    );
    if (declared?.hand.length === 1) {
      events.push({
        type: "uno_declared",
        actorPlayerId: declared.playerId,
        message: `${declared.displayName} called UNO.`,
      });
    }
  }
}

function closeUnoReactionWindow(state: GameState): void {
  state.unoLiabilities = [];
}

function drawCardsWithImmediateMercy(
  state: GameState,
  player: PlayerState,
  count: number,
  sourcePlayerId: string | null,
  events: GameEvent[],
): void {
  for (let index = 0; index < count; index += 1) {
    player.hand.push(drawOne(state));
    if (player.hand.length >= 25) {
      eliminatePlayer(state, player, sourcePlayerId, events);
      repairTurnAfterRemoval(state, player, events);
      break;
    }
  }
}

function drawOne(state: GameState): Card {
  if (state.drawPile.length === 0) recycleDrawPile(state);
  const card = state.drawPile.pop();
  if (!card) {
    throw new GameRuleError(
      "DECK_EXHAUSTED",
      "No cards are available to continue this draw.",
      409,
    );
  }
  return card;
}

function recycleDrawPile(state: GameState): void {
  const top = state.discardPile.pop();
  if (!top) {
    throw new GameRuleError("DECK_EXHAUSTED", "No discard is available.", 409);
  }
  const pool = [...state.discardPile, ...state.mercyReserve];
  state.discardPile = [top];
  state.mercyReserve = [];
  if (pool.length === 0) {
    throw new GameRuleError("DECK_EXHAUSTED", "No cards can be recycled.", 409);
  }
  state.rngState = shuffleInPlace(pool, state.rngState);
  state.drawPile = pool;
}

function eliminatePlayer(
  state: GameState,
  player: PlayerState,
  sourcePlayerId: string | null,
  events: GameEvent[],
): void {
  state.mercyReserve.push(...player.hand);
  player.hand = [];
  player.status = "eliminated";
  player.knockedOutBy = sourcePlayerId;
  state.unoLiabilities = state.unoLiabilities.filter(
    (entry) => entry.playerId !== player.playerId,
  );
  if (state.forcedCardId) state.forcedCardId = null;
  events.push({
    type: "player_eliminated",
    actorPlayerId: sourcePlayerId,
    message: `${player.displayName} reached 25 cards and was knocked out.`,
    data: { playerId: player.playerId },
  });
}

function repairTurnAfterRemoval(
  state: GameState,
  removed: PlayerState,
  events: GameEvent[],
): void {
  const remaining = activePlayers(state);
  if (remaining.length === 1) {
    completeGame(state, remaining[0], "last_active", events);
    return;
  }
  if (remaining.length === 0) {
    throw new GameRuleError("NO_ACTIVE_PLAYER", "No active player remains.", 500);
  }
  if (
    state.currentPlayerId === removed.playerId ||
    state.rouletteTargetId === removed.playerId
  ) {
    state.currentPlayerId = nextActivePlayer(state, removed.playerId).playerId;
  }
  if (state.rouletteTargetId === removed.playerId) state.rouletteTargetId = null;
}

function completeGame(
  state: GameState,
  winner: PlayerState,
  reason: "empty_hand" | "last_active",
  events: GameEvent[],
): void {
  state.phase = "complete";
  state.winner = { playerId: winner.playerId, reason };
  state.currentPlayerId = null;
  state.pendingDraw = null;
  state.rouletteTargetId = null;
  state.forcedCardId = null;
  state.unoLiabilities = [];
  events.push({
    type: "game_won",
    actorPlayerId: winner.playerId,
    message: `${winner.displayName} won by ${
      reason === "empty_hand" ? "playing their final card" : "being the last player standing"
    }.`,
    data: { reason },
  });
}

function rememberCommand(
  state: GameState,
  actorUserId: string,
  commandId: string,
): void {
  state.processedCommands.push({ actorUserId, commandId });
  if (state.processedCommands.length > 64) {
    state.processedCommands.splice(0, state.processedCommands.length - 64);
  }
}

function cleanDisplayName(value: string): string {
  const cleaned = Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .trim()
    .slice(0, 28);
  return cleaned || "Player";
}

function cloneState(state: GameState): GameState {
  return structuredClone(state);
}
