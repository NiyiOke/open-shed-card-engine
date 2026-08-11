import assert from "node:assert/strict";
import test from "node:test";
import { createDeck, drawValue } from "../lib/game/deck";
import {
  createLobbyState,
  joinLobbyState,
  transitionGame,
} from "../lib/game/engine";
import { GameRuleError } from "../lib/game/errors";
import { projectGameForUser } from "../lib/game/projection";
import type {
  Card,
  GameCommand,
  GameState,
  TransitionContext,
} from "../lib/game/types";

const HOST = { userId: "user-a", playerId: "player-a", name: "Ada" };
const B = { userId: "user-b", playerId: "player-b", name: "Ben" };
const C = { userId: "user-c", playerId: "player-c", name: "Cy" };

test("the independently validated deck manifest has 168 unique physical cards", () => {
  const deck = createDeck();
  assert.equal(deck.length, 168);
  assert.equal(new Set(deck.map((card) => card.id)).size, 168);
  assert.equal(deck.filter((card) => card.kind === "number").length, 80);
  assert.equal(deck.filter((card) => drawValue(card) !== null).length, 36);
  for (const color of ["red", "yellow", "green", "blue"]) {
    assert.equal(deck.filter((card) => card.color === color).length, 36);
  }
});

test("setup deals seven cards and ignores opening actions until a number is visible", () => {
  const state = startedGame([HOST, B, C]);
  assert.equal(state.phase, "playing");
  assert.deepEqual(
    state.players.map((player) => player.hand.length),
    [7, 7, 7],
  );
  assert.equal(state.discardPile.at(-1)?.kind, "number");
  assert.equal(allCards(state).length, 168);
  assert.equal(new Set(allCards(state).map((card) => card.id)).size, 168);
  assert.equal(state.currentPlayerId, B.playerId);
});

test("a draw stack compares against the last value and accumulates the full total", () => {
  let state = startedGame([HOST, B, C]);
  state = forceTurn(state, HOST.playerId);
  const top = moveCard(state, (card) => card.color === "red" && card.number === 5);
  setTopDiscard(state, top);
  const plusTwo = moveCard(
    state,
    (card) => card.color === "red" && card.kind === "draw_two",
  );
  giveOnlyAdditionalCard(state, HOST.playerId, plusTwo);
  const plusSix = moveCard(state, (card) => card.kind === "wild_draw_six");
  giveOnlyAdditionalCard(state, B.playerId, plusSix);

  state = run(state, HOST.userId, {
    type: "play_card",
    cardId: plusTwo.id,
  });
  assert.deepEqual(state.pendingDraw, {
    total: 2,
    minimum: 2,
    sourcePlayerId: HOST.playerId,
  });
  assert.equal(state.currentPlayerId, B.playerId);

  state = run(state, B.userId, {
    type: "play_card",
    cardId: plusSix.id,
    chosenColor: "blue",
  });
  assert.equal(state.pendingDraw?.total, 8);
  assert.equal(state.pendingDraw?.minimum, 6);
  assert.equal(state.currentPlayerId, C.playerId);
});

test("Skip makes the next player lose their turn", () => {
  let state = forceTurn(startedGame([HOST, B, C]), HOST.playerId);
  setTopDiscard(
    state,
    moveCard(state, (card) => card.color === "red" && card.number === 5),
  );
  const skip = moveCard(
    state,
    (card) => card.color === "red" && card.kind === "skip",
  );
  giveOnlyAdditionalCard(state, HOST.playerId, skip);
  const turnBefore = state.turnNumber;

  state = run(state, HOST.userId, { type: "play_card", cardId: skip.id });

  assert.equal(state.currentPlayerId, C.playerId);
  assert.equal(state.direction, 1);
  assert.equal(state.turnNumber, turnBefore + 1);
});

test("Reverse changes direction before selecting the next player", () => {
  const scenarios = [
    { initialDirection: 1 as const, expectedDirection: -1 as const, expected: C },
    { initialDirection: -1 as const, expectedDirection: 1 as const, expected: B },
  ];

  for (const scenario of scenarios) {
    let state = forceTurn(startedGame([HOST, B, C]), HOST.playerId);
    state.direction = scenario.initialDirection;
    setTopDiscard(
      state,
      moveCard(state, (card) => card.color === "red" && card.number === 5),
    );
    const reverse = moveCard(
      state,
      (card) => card.color === "red" && card.kind === "reverse",
    );
    giveOnlyAdditionalCard(state, HOST.playerId, reverse);

    state = run(state, HOST.userId, {
      type: "play_card",
      cardId: reverse.id,
    });

    assert.equal(state.direction, scenario.expectedDirection);
    assert.equal(state.currentPlayerId, scenario.expected.playerId);
  }
});

test("Reverse acts as a skip in a two-player game", () => {
  let state = forceTurn(startedGame([HOST, B]), HOST.playerId);
  setTopDiscard(
    state,
    moveCard(state, (card) => card.color === "red" && card.number === 5),
  );
  const reverse = moveCard(
    state,
    (card) => card.color === "red" && card.kind === "reverse",
  );
  giveOnlyAdditionalCard(state, HOST.playerId, reverse);

  state = run(state, HOST.userId, {
    type: "play_card",
    cardId: reverse.id,
  });

  assert.equal(state.direction, -1);
  assert.equal(state.currentPlayerId, HOST.playerId);
});

test("Discard All places matching cards under itself without resolving their effects", () => {
  let state = forceTurn(startedGame([HOST, B, C]), HOST.playerId);
  setTopDiscard(
    state,
    moveCard(state, (card) => card.color === "red" && card.number === 5),
  );
  const extraSkip = moveCard(
    state,
    (card) => card.color === "red" && card.kind === "skip",
  );
  const keeper = moveCard(
    state,
    (card) => card.color === "blue" && card.number === 1,
  );
  const extraReverse = moveCard(
    state,
    (card) => card.color === "red" && card.kind === "reverse",
  );
  const extraDrawFour = moveCard(
    state,
    (card) => card.color === "red" && card.kind === "draw_four",
  );
  const discardAll = moveCard(
    state,
    (card) => card.color === "red" && card.kind === "discard_all",
  );
  replaceHand(state, HOST.playerId, [
    extraSkip,
    keeper,
    extraReverse,
    extraDrawFour,
    discardAll,
  ]);
  const discardCountBefore = state.discardPile.length;

  state = run(state, HOST.userId, {
    type: "play_card",
    cardId: discardAll.id,
    declareUno: true,
  });

  assert.deepEqual(state.discardPile.slice(-4).map((card) => card.id), [
    extraSkip.id,
    extraReverse.id,
    extraDrawFour.id,
    discardAll.id,
  ]);
  assert.equal(state.discardPile.length, discardCountBefore + 4);
  assert.deepEqual(handIds(state, HOST.playerId), [keeper.id]);
  assert.equal(state.discardPile.at(-1)?.id, discardAll.id);
  assert.equal(state.pendingDraw, null);
  assert.equal(state.direction, 1);
  assert.equal(state.currentPlayerId, B.playerId);
});

test("Skip Everyone returns play to the same player", () => {
  let state = forceTurn(startedGame([HOST, B, C]), HOST.playerId);
  setTopDiscard(
    state,
    moveCard(state, (card) => card.color === "red" && card.number === 5),
  );
  const skipEveryone = moveCard(
    state,
    (card) => card.color === "red" && card.kind === "skip_everyone",
  );
  giveOnlyAdditionalCard(state, HOST.playerId, skipEveryone);

  state = run(state, HOST.userId, {
    type: "play_card",
    cardId: skipEveryone.id,
  });

  assert.equal(state.currentPlayerId, HOST.playerId);
  assert.equal(state.direction, 1);
  assert.equal(state.pendingDraw, null);
});

test("Wild Reverse Draw Four targets its player in a two-player game", () => {
  let state = forceTurn(startedGame([HOST, B]), HOST.playerId);
  const reverseDrawFour = moveCard(
    state,
    (card) => card.kind === "wild_reverse_draw_four",
  );
  giveOnlyAdditionalCard(state, HOST.playerId, reverseDrawFour);

  state = run(state, HOST.userId, {
    type: "play_card",
    cardId: reverseDrawFour.id,
    chosenColor: "blue",
  });

  assert.equal(state.direction, -1);
  assert.equal(state.currentPlayerId, HOST.playerId);
  assert.deepEqual(state.pendingDraw, {
    total: 4,
    minimum: 4,
    sourcePlayerId: HOST.playerId,
  });

  const handSizeBeforePenalty = handIds(state, HOST.playerId).length;
  state = run(state, HOST.userId, { type: "accept_penalty" });
  assert.equal(handIds(state, HOST.playerId).length, handSizeBeforePenalty + 4);
  assert.equal(state.currentPlayerId, B.playerId);
});

test("Wild Reverse Draw Four reverses before targeting in a three-player game", () => {
  const scenarios = [
    { initialDirection: 1 as const, expectedDirection: -1 as const, target: C },
    { initialDirection: -1 as const, expectedDirection: 1 as const, target: B },
  ];

  for (const scenario of scenarios) {
    let state = forceTurn(startedGame([HOST, B, C]), HOST.playerId);
    state.direction = scenario.initialDirection;
    const reverseDrawFour = moveCard(
      state,
      (card) => card.kind === "wild_reverse_draw_four",
    );
    giveOnlyAdditionalCard(state, HOST.playerId, reverseDrawFour);

    state = run(state, HOST.userId, {
      type: "play_card",
      cardId: reverseDrawFour.id,
      chosenColor: "green",
    });

    assert.equal(state.direction, scenario.expectedDirection);
    assert.equal(state.currentPlayerId, scenario.target.playerId);
    assert.equal(state.pendingDraw?.sourcePlayerId, HOST.playerId);
    assert.equal(state.pendingDraw?.total, 4);
  }
});

test("Color Roulette ignores Wilds and its target loses their turn", () => {
  let state = forceTurn(startedGame([HOST, B, C]), HOST.playerId);
  const roulette = moveCard(
    state,
    (card) => card.kind === "wild_color_roulette",
  );
  giveOnlyAdditionalCard(state, HOST.playerId, roulette);
  const revealOrder = [
    moveCard(state, (card) => card.kind === "wild_draw_six"),
    moveCard(state, (card) => card.kind === "wild_reverse_draw_four"),
    moveCard(state, (card) => card.color === "blue" && card.number === 2),
    moveCard(state, (card) => card.color === "red" && card.number === 3),
  ];
  queueNextDraws(state, revealOrder);

  state = run(state, HOST.userId, {
    type: "play_card",
    cardId: roulette.id,
  });
  assert.equal(state.rouletteTargetId, B.playerId);
  assert.equal(state.currentPlayerId, B.playerId);
  const targetHandSize = handIds(state, B.playerId).length;

  state = run(state, B.userId, {
    type: "choose_roulette_color",
    color: "red",
  });

  assert.equal(handIds(state, B.playerId).length, targetHandSize + 4);
  assert.deepEqual(handIds(state, B.playerId).slice(-4), revealOrder.map(cardId));
  assert.equal(state.activeColor, "red");
  assert.equal(state.rouletteTargetId, null);
  assert.equal(state.currentPlayerId, C.playerId);
});

test("drawing continues until the first match, which must then be played", () => {
  let state = forceTurn(startedGame([HOST, B, C]), HOST.playerId);
  setTopDiscard(
    state,
    moveCard(state, (card) => card.color === "red" && card.number === 5),
  );
  const heldCards = [
    moveCard(state, (card) => card.color === "blue" && card.number === 1),
    moveCard(state, (card) => card.color === "green" && card.number === 3),
  ];
  replaceHand(state, HOST.playerId, heldCards);
  const drawOrder = [
    moveCard(state, (card) => card.color === "yellow" && card.number === 4),
    moveCard(state, (card) => card.color === "blue" && card.number === 6),
    moveCard(state, (card) => card.color === "red" && card.number === 8),
  ];
  queueNextDraws(state, drawOrder);
  const turnBefore = state.turnNumber;

  state = run(state, HOST.userId, { type: "draw_until_playable" });

  assert.deepEqual(handIds(state, HOST.playerId), [
    ...heldCards.map(cardId),
    ...drawOrder.map(cardId),
  ]);
  assert.equal(state.forcedCardId, drawOrder.at(-1)?.id);
  assert.equal(state.currentPlayerId, HOST.playerId);
  assert.equal(state.turnNumber, turnBefore);
  expectRuleError(
    () =>
      run(state, HOST.userId, {
        type: "play_card",
        cardId: heldCards[0].id,
      }),
    "FORCED_CARD_REQUIRED",
  );

  state = run(state, HOST.userId, {
    type: "play_card",
    cardId: drawOrder.at(-1)!.id,
  });
  assert.equal(state.forcedCardId, null);
  assert.equal(state.currentPlayerId, B.playerId);
  assert.equal(state.turnNumber, turnBefore + 1);
});

test("a timely UNO declaration prevents a catch after the next turn begins", () => {
  const fixture = preparedUnoWindow();
  let state = run(fixture.state, HOST.userId, {
    type: "play_card",
    cardId: fixture.hostPlay.id,
    declareUno: true,
  });

  assert.deepEqual(state.unoLiabilities, []);
  state = run(state, B.userId, {
    type: "play_card",
    cardId: fixture.nextPlay.id,
  });

  assert.deepEqual(state.unoLiabilities, []);
  expectRuleError(
    () =>
      run(state, C.userId, {
        type: "catch_uno",
        offenderPlayerId: HOST.playerId,
      }),
    "UNO_WINDOW_CLOSED",
  );
});

test("a player may declare UNO during the reaction window", () => {
  const fixture = preparedUnoWindow();
  let state = run(fixture.state, HOST.userId, {
    type: "play_card",
    cardId: fixture.hostPlay.id,
  });
  assert.deepEqual(state.unoLiabilities.map((entry) => entry.playerId), [
    HOST.playerId,
  ]);

  state = run(state, HOST.userId, { type: "declare_uno" });

  assert.deepEqual(state.unoLiabilities, []);
  expectRuleError(
    () =>
      run(state, B.userId, {
        type: "catch_uno",
        offenderPlayerId: HOST.playerId,
      }),
    "UNO_WINDOW_CLOSED",
  );
});

test("an undeclared UNO can be caught before the next player begins", () => {
  const fixture = preparedUnoWindow();
  let state = run(fixture.state, HOST.userId, {
    type: "play_card",
    cardId: fixture.hostPlay.id,
  });

  assert.deepEqual(state.unoLiabilities.map((entry) => entry.playerId), [
    HOST.playerId,
  ]);
  const offenderHandSize = handIds(state, HOST.playerId).length;
  state = run(state, B.userId, {
    type: "catch_uno",
    offenderPlayerId: HOST.playerId,
  });

  assert.equal(handIds(state, HOST.playerId).length, offenderHandSize + 2);
  assert.deepEqual(state.unoLiabilities, []);
  assert.equal(state.currentPlayerId, B.playerId);
});

test("an UNO catch window closes when the next player begins their turn", () => {
  const fixture = preparedUnoWindow();
  let state = run(fixture.state, HOST.userId, {
    type: "play_card",
    cardId: fixture.hostPlay.id,
  });
  assert.deepEqual(state.unoLiabilities.map((entry) => entry.playerId), [
    HOST.playerId,
  ]);

  state = run(state, B.userId, {
    type: "play_card",
    cardId: fixture.nextPlay.id,
  });

  assert.deepEqual(state.unoLiabilities, []);
  expectRuleError(
    () =>
      run(state, C.userId, {
        type: "catch_uno",
        offenderPlayerId: HOST.playerId,
      }),
    "UNO_WINDOW_CLOSED",
  );
});

test("replaying a processed command is idempotent", () => {
  const fixture = preparedUnoWindow();
  const context: TransitionContext = {
    actorUserId: HOST.userId,
    commandId: "stable-play-command",
    now: fixture.state.updatedAt + 1,
  };
  const command: GameCommand = {
    type: "play_card",
    cardId: fixture.hostPlay.id,
    declareUno: true,
  };

  const first = transitionGame(fixture.state, command, context);
  const snapshot = structuredClone(first.state);
  const replay = transitionGame(first.state, command, context);

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.state, first.state);
  assert.deepEqual(replay.events, []);
  assert.deepEqual(replay.state, snapshot);
});

test("an empty draw pile recycles lower discards and Mercy cards without card loss", () => {
  let state = forceTurn(startedGame([HOST, B, C]), HOST.playerId);
  setTopDiscard(
    state,
    moveCard(state, (card) => card.color === "red" && card.number === 5),
  );
  const plusTwo = moveCard(
    state,
    (card) => card.color === "red" && card.kind === "draw_two",
  );
  giveOnlyAdditionalCard(state, HOST.playerId, plusTwo);
  state = run(state, HOST.userId, {
    type: "play_card",
    cardId: plusTwo.id,
  });

  state.mercyReserve.push(...state.drawPile);
  state.drawPile = [];
  const visibleDiscardId = state.discardPile.at(-1)!.id;
  const targetHandSize = handIds(state, B.playerId).length;
  const recyclableCount = state.discardPile.length - 1 + state.mercyReserve.length;
  const cardsBefore = sortedCardIds(state);

  state = run(state, B.userId, { type: "accept_penalty" });

  assert.equal(state.discardPile.at(-1)?.id, visibleDiscardId);
  assert.equal(state.discardPile.length, 1);
  assert.equal(state.mercyReserve.length, 0);
  assert.equal(state.drawPile.length, recyclableCount - 2);
  assert.equal(handIds(state, B.playerId).length, targetHandSize + 2);
  assert.equal(state.currentPlayerId, C.playerId);
  assert.deepEqual(sortedCardIds(state), cardsBefore);
  assert.equal(allCards(state).length, 168);
});

test("a draw stack rejects cards lower than the last stacked value", () => {
  const cases: Array<{
    sourceKind: Card["kind"];
    lowerKind: Card["kind"];
    sourceColor?: Card["color"];
  }> = [
    { sourceKind: "draw_four", lowerKind: "draw_two", sourceColor: "red" },
    { sourceKind: "wild_draw_six", lowerKind: "draw_four" },
    { sourceKind: "wild_draw_ten", lowerKind: "wild_draw_six" },
  ];

  for (const scenario of cases) {
    let state = forceTurn(startedGame([HOST, B, C]), HOST.playerId);
    setTopDiscard(
      state,
      moveCard(state, (card) => card.color === "red" && card.number === 5),
    );
    const source = moveCard(
      state,
      (card) =>
        card.kind === scenario.sourceKind &&
        (scenario.sourceColor === undefined || card.color === scenario.sourceColor),
    );
    const lower = moveCard(state, (card) => card.kind === scenario.lowerKind);
    giveOnlyAdditionalCard(state, HOST.playerId, source);
    giveOnlyAdditionalCard(state, B.playerId, lower);

    state = run(state, HOST.userId, {
      type: "play_card",
      cardId: source.id,
      ...(source.color === null ? { chosenColor: "blue" as const } : {}),
    });
    const beforeRejectedStack = structuredClone(state);

    expectRuleError(
      () =>
        run(state, B.userId, {
          type: "play_card",
          cardId: lower.id,
          ...(lower.color === null ? { chosenColor: "green" as const } : {}),
        }),
      "INVALID_STACK",
    );
    assert.deepEqual(state, beforeRejectedStack);
  }
});

test("Mercy removes a player immediately on the 25th card of a penalty", () => {
  let state = startedGame([HOST, B, C]);
  state = forceTurn(state, HOST.playerId);
  setTopDiscard(
    state,
    moveCard(state, (card) => card.color === "red" && card.number === 5),
  );
  const plusTwo = moveCard(
    state,
    (card) => card.color === "red" && card.kind === "draw_two",
  );
  giveOnlyAdditionalCard(state, HOST.playerId, plusTwo);
  setHandSize(state, B.playerId, 24);

  state = run(state, HOST.userId, {
    type: "play_card",
    cardId: plusTwo.id,
  });
  const beforeDrawCount = state.drawPile.length;
  state = run(state, B.userId, { type: "accept_penalty" });

  const playerB = state.players.find((player) => player.playerId === B.playerId)!;
  assert.equal(playerB.status, "eliminated");
  assert.equal(playerB.hand.length, 0);
  assert.equal(state.drawPile.length, beforeDrawCount - 1);
  assert.ok(state.mercyReserve.length >= 25);
  assert.equal(allCards(state).length, 168);
});

test("zero rotates post-play hands simultaneously in the current direction", () => {
  let state = startedGame([HOST, B, C]);
  state = forceTurn(state, HOST.playerId);
  setTopDiscard(
    state,
    moveCard(state, (card) => card.color === "red" && card.number === 5),
  );
  const zero = moveCard(
    state,
    (card) => card.color === "red" && card.number === 0,
  );
  giveOnlyAdditionalCard(state, HOST.playerId, zero);
  const hostBefore = state.players.find((player) => player.playerId === HOST.playerId)!.hand;
  const hostPostPlay = hostBefore.filter((card) => card.id !== zero.id).map((card) => card.id);
  const bBefore = state.players.find((player) => player.playerId === B.playerId)!.hand.map((card) => card.id);
  const cBefore = state.players.find((player) => player.playerId === C.playerId)!.hand.map((card) => card.id);

  state = run(state, HOST.userId, { type: "play_card", cardId: zero.id });

  assert.deepEqual(handIds(state, B.playerId), hostPostPlay);
  assert.deepEqual(handIds(state, C.playerId), bBefore);
  assert.deepEqual(handIds(state, HOST.playerId), cBefore);
});

test("a final seven wins before its external swap under the pinned rules profile", () => {
  let state = startedGame([HOST, B]);
  state = forceTurn(state, HOST.playerId);
  setTopDiscard(
    state,
    moveCard(state, (card) => card.color === "red" && card.number === 5),
  );
  const seven = moveCard(
    state,
    (card) => card.color === "red" && card.number === 7,
  );
  replaceHand(state, HOST.playerId, [seven]);
  const targetHand = handIds(state, B.playerId);

  state = run(state, HOST.userId, {
    type: "play_card",
    cardId: seven.id,
    swapTargetId: B.playerId,
  });

  assert.equal(state.phase, "complete");
  assert.deepEqual(state.winner, {
    playerId: HOST.playerId,
    reason: "empty_hand",
  });
  assert.deepEqual(handIds(state, B.playerId), targetHand);
});

test("a final draw card wins before creating a penalty", () => {
  let state = forceTurn(startedGame([HOST, B]), HOST.playerId);
  setTopDiscard(
    state,
    moveCard(state, (card) => card.color === "red" && card.number === 5),
  );
  const drawTwo = moveCard(
    state,
    (card) => card.color === "red" && card.kind === "draw_two",
  );
  replaceHand(state, HOST.playerId, [drawTwo]);
  const targetHand = handIds(state, B.playerId);

  state = run(state, HOST.userId, {
    type: "play_card",
    cardId: drawTwo.id,
  });

  assert.equal(state.phase, "complete");
  assert.equal(state.pendingDraw, null);
  assert.deepEqual(handIds(state, B.playerId), targetHand);
});

test("Discard All completes its same-color removals before checking victory", () => {
  let state = forceTurn(startedGame([HOST, B]), HOST.playerId);
  setTopDiscard(
    state,
    moveCard(state, (card) => card.color === "red" && card.number === 5),
  );
  const discardAll = moveCard(
    state,
    (card) => card.color === "red" && card.kind === "discard_all",
  );
  const extraRed = moveCard(
    state,
    (card) => card.color === "red" && card.number === 8,
  );
  replaceHand(state, HOST.playerId, [discardAll, extraRed]);

  state = run(state, HOST.userId, {
    type: "play_card",
    cardId: discardAll.id,
  });

  assert.equal(state.phase, "complete");
  assert.deepEqual(handIds(state, HOST.playerId), []);
  assert.deepEqual(state.discardPile.slice(-2).map(cardId), [extraRed.id, discardAll.id]);
});

test("a non-final seven swaps the post-play hand and opens UNO for its recipient", () => {
  let state = forceTurn(startedGame([HOST, B, C]), HOST.playerId);
  setTopDiscard(
    state,
    moveCard(state, (card) => card.color === "red" && card.number === 5),
  );
  const seven = moveCard(
    state,
    (card) => card.color === "red" && card.number === 7,
  );
  const keeper = moveCard(
    state,
    (card) => card.color === "blue" && card.number === 2,
  );
  replaceHand(state, HOST.playerId, [seven, keeper]);
  const targetHand = handIds(state, B.playerId);

  state = run(state, HOST.userId, {
    type: "play_card",
    cardId: seven.id,
    swapTargetId: B.playerId,
  });

  assert.deepEqual(handIds(state, HOST.playerId), targetHand);
  assert.deepEqual(handIds(state, B.playerId), [keeper.id]);
  assert.deepEqual(state.unoLiabilities.map((entry) => entry.playerId), [B.playerId]);
});

test("Color Roulette safely drains recyclable cards when its color is unavailable", () => {
  let state = forceTurn(startedGame([HOST, B, C]), HOST.playerId);
  const roulette = moveCard(state, (card) => card.kind === "wild_color_roulette");
  const keeper = moveCard(
    state,
    (card) => card.color === "yellow" && card.number === 1,
  );
  replaceHand(state, HOST.playerId, [roulette, keeper]);

  const blueCards = allCards(state)
    .filter((card) => card.color === "blue")
    .map((card) => removeCardEverywhere(state, card.id));
  const players = state.players;
  blueCards.forEach((card, index) => players[index % players.length].hand.push(card));

  state = run(state, HOST.userId, {
    type: "play_card",
    cardId: roulette.id,
  });
  state = run(state, B.userId, {
    type: "choose_roulette_color",
    color: "blue",
  });

  assert.equal(state.rouletteTargetId, null);
  assert.equal(state.activeColor, "blue");
  assert.equal(state.drawPile.length, 0);
  assert.equal(allCards(state).length, 168);
  assert.equal(new Set(allCards(state).map(cardId)).size, 168);
});

test("viewer projection exposes only the viewer's private hand", () => {
  const state = startedGame([HOST, B]);
  const view = projectGameForUser(state, HOST.userId);
  assert.deepEqual(
    view.hand.map((card) => card.id),
    handIds(state, HOST.playerId),
  );
  assert.equal(view.players.find((player) => player.playerId === B.playerId)?.cardCount, 7);
  assert.equal("hand" in view.players[1], false);
  assert.equal(JSON.stringify(view).includes(handIds(state, B.playerId)[0]), false);
  assert.equal(JSON.stringify(view).includes(state.drawPile.at(-1)!.id), false);
});

test("production lobby identifiers do not determine shuffle entropy", () => {
  const state = createLobbyState({
    gameId: "public-game-id",
    joinCode: "PUBLIC",
    hostUserId: HOST.userId,
    hostPlayerId: HOST.playerId,
    hostDisplayName: HOST.name,
    now: 1,
  });

  assert.equal(state.rngState, null);
  assert.equal("rngState" in projectGameForUser(state, HOST.userId), false);
});

test("a forced drawn card is visible only to its owner", () => {
  let state = forceTurn(startedGame([HOST, B, C]), HOST.playerId);
  setTopDiscard(
    state,
    moveCard(state, (card) => card.color === "red" && card.number === 5),
  );
  replaceHand(state, HOST.playerId, [
    moveCard(state, (card) => card.color === "blue" && card.number === 1),
  ]);
  const forced = moveCard(
    state,
    (card) => card.color === "red" && card.number === 8,
  );
  queueNextDraws(state, [forced]);

  state = run(state, HOST.userId, { type: "draw_until_playable" });

  assert.equal(projectGameForUser(state, HOST.userId).forcedCardId, forced.id);
  const opponentView = projectGameForUser(state, B.userId);
  assert.equal(opponentView.forcedCardId, null);
  assert.equal(JSON.stringify(opponentView).includes(forced.id), false);
});

test("leaving during a forced play clears turn-owned transient state", () => {
  let state = forceTurn(startedGame([HOST, B, C]), HOST.playerId);
  setTopDiscard(
    state,
    moveCard(state, (card) => card.color === "red" && card.number === 5),
  );
  replaceHand(state, HOST.playerId, [
    moveCard(state, (card) => card.color === "blue" && card.number === 1),
  ]);
  const forced = moveCard(
    state,
    (card) => card.color === "red" && card.number === 8,
  );
  queueNextDraws(state, [forced]);
  state = run(state, HOST.userId, { type: "draw_until_playable" });
  assert.equal(state.forcedCardId, forced.id);

  state = run(state, HOST.userId, { type: "leave_game" });

  assert.equal(state.players.find((player) => player.playerId === HOST.playerId)?.status, "left");
  assert.equal(state.forcedCardId, null);
  assert.equal(state.pendingDraw, null);
  assert.equal(state.currentPlayerId, B.playerId);
});

test("an empty lobby closes cleanly while returning a final viewer projection", () => {
  let state = createLobbyState({
    gameId: "abandoned-game",
    joinCode: "CLOSE1",
    hostUserId: HOST.userId,
    hostPlayerId: HOST.playerId,
    hostDisplayName: HOST.name,
    now: 1,
    seed: 7,
  });

  state = run(state, HOST.userId, { type: "leave_game" });

  assert.equal(state.phase, "complete");
  assert.equal(state.players[0].status, "left");
  assert.equal(projectGameForUser(state, HOST.userId).phase, "complete");
  expectRuleError(
    () => run(state, HOST.userId, { type: "leave_game" }),
    "GAME_COMPLETE",
  );
});

function startedGame(
  players: Array<{ userId: string; playerId: string; name: string }>,
): GameState {
  let state = createLobbyState({
    gameId: "game-test",
    joinCode: "ABC123",
    hostUserId: players[0].userId,
    hostPlayerId: players[0].playerId,
    hostDisplayName: players[0].name,
    now: 1,
    seed: 123456789,
  });
  for (const player of players.slice(1)) {
    state = joinLobbyState(state, {
      userId: player.userId,
      playerId: player.playerId,
      displayName: player.name,
      commandId: `join-${player.playerId}`,
      now: state.updatedAt + 1,
    }).state;
  }
  for (const player of players) {
    state = run(state, player.userId, { type: "set_ready", ready: true });
  }
  return run(state, players[0].userId, { type: "start_game" });
}

let commandSequence = 0;
function run(state: GameState, actorUserId: string, command: GameCommand): GameState {
  commandSequence += 1;
  const context: TransitionContext = {
    actorUserId,
    commandId: `command-${commandSequence}`,
    now: state.updatedAt + 1,
  };
  return transitionGame(state, command, context).state;
}

function allCards(state: GameState): Card[] {
  return [
    ...state.drawPile,
    ...state.discardPile,
    ...state.mercyReserve,
    ...state.players.flatMap((player) => player.hand),
  ];
}

function removeCardEverywhere(state: GameState, cardId: string): Card {
  const zones: Card[][] = [
    state.drawPile,
    state.discardPile,
    state.mercyReserve,
    ...state.players.map((player) => player.hand),
  ];
  for (const zone of zones) {
    const index = zone.findIndex((card) => card.id === cardId);
    if (index >= 0) return zone.splice(index, 1)[0];
  }
  throw new Error(`Card ${cardId} was not found.`);
}

function moveCard(state: GameState, predicate: (card: Card) => boolean): Card {
  const card = allCards(state).find(predicate);
  if (!card) throw new Error("Fixture card was not found.");
  return removeCardEverywhere(state, card.id);
}

function cardId(card: Card): string {
  return card.id;
}

function queueNextDraws(state: GameState, cardsInDrawOrder: Card[]): void {
  state.drawPile.push(...[...cardsInDrawOrder].reverse());
}

function preparedUnoWindow(): {
  state: GameState;
  hostPlay: Card;
  nextPlay: Card;
} {
  const state = forceTurn(startedGame([HOST, B, C]), HOST.playerId);
  setTopDiscard(
    state,
    moveCard(state, (card) => card.color === "red" && card.number === 5),
  );
  const hostPlay = moveCard(
    state,
    (card) => card.color === "red" && card.number === 6,
  );
  const hostLastCard = moveCard(
    state,
    (card) => card.color === "blue" && card.number === 9,
  );
  const nextPlay = moveCard(
    state,
    (card) => card.color === "red" && card.number === 8,
  );
  replaceHand(state, HOST.playerId, [hostPlay, hostLastCard]);
  giveOnlyAdditionalCard(state, B.playerId, nextPlay);
  return { state, hostPlay, nextPlay };
}

function expectRuleError(action: () => unknown, code: string): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof GameRuleError && error.code === code,
  );
}

function sortedCardIds(state: GameState): string[] {
  return allCards(state).map(cardId).sort();
}

function setTopDiscard(state: GameState, card: Card): void {
  const previousTop = state.discardPile.pop();
  if (previousTop) state.drawPile.unshift(previousTop);
  state.discardPile.push(card);
  state.activeColor = card.color;
}

function giveOnlyAdditionalCard(
  state: GameState,
  playerId: string,
  card: Card,
): void {
  state.players.find((player) => player.playerId === playerId)!.hand.push(card);
}

function replaceHand(state: GameState, playerId: string, cards: Card[]): void {
  const player = state.players.find((candidate) => candidate.playerId === playerId)!;
  state.drawPile.unshift(...player.hand);
  player.hand = cards;
}

function setHandSize(state: GameState, playerId: string, size: number): void {
  const player = state.players.find((candidate) => candidate.playerId === playerId)!;
  if (player.hand.length > size) {
    state.drawPile.unshift(...player.hand.splice(size));
  }
  while (player.hand.length < size) {
    const card = state.drawPile.shift();
    if (!card) throw new Error("Not enough fixture cards.");
    player.hand.push(card);
  }
}

function forceTurn(state: GameState, playerId: string): GameState {
  const copy = structuredClone(state);
  copy.currentPlayerId = playerId;
  copy.pendingDraw = null;
  copy.rouletteTargetId = null;
  copy.forcedCardId = null;
  copy.unoLiabilities = [];
  return copy;
}

function handIds(state: GameState, playerId: string): string[] {
  return state.players
    .find((player) => player.playerId === playerId)!
    .hand.map((card) => card.id);
}
