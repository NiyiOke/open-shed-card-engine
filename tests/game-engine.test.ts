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

test("the host can open an idempotent rematch lobby from a completed game", () => {
  const completed = completedGameWithEliminatedAndLeftPlayers();
  const completedSnapshot = structuredClone(completed);
  const completedRevision = completed.revision;
  const completedRngState = completed.rngState;
  const completedCommandHistory = structuredClone(completed.processedCommands);

  const hostView = projectGameForUser(completed, HOST.userId);
  const opponentView = projectGameForUser(completed, B.userId);
  assert.equal(hostView.legalActions.canRematch, true);
  assert.equal(opponentView.legalActions.canRematch, false);

  const context: TransitionContext = {
    actorUserId: HOST.userId,
    commandId: "stable-rematch-command",
    now: completed.updatedAt + 10,
  };
  const first = transitionGame(completed, { type: "rematch" }, context);

  assert.equal(first.replayed, false);
  assert.deepEqual(completed, completedSnapshot);
  assert.equal(first.state.phase, "lobby");
  assert.equal(first.state.gameId, completed.gameId);
  assert.equal(first.state.joinCode, completed.joinCode);
  assert.equal(first.state.hostUserId, completed.hostUserId);
  assert.equal(first.state.createdAt, completed.createdAt);
  assert.equal(first.state.rngState, completedRngState);
  assert.equal(first.state.revision, completedRevision + 1);
  assert.equal(first.state.updatedAt, context.now);
  assert.deepEqual(
    first.state.processedCommands,
    [
      ...completedCommandHistory,
      { actorUserId: HOST.userId, commandId: context.commandId },
    ].slice(-64),
  );
  assert.deepEqual(
    first.state.players.map((player) => ({
      playerId: player.playerId,
      seat: player.seat,
      ready: player.ready,
      status: player.status,
      handSize: player.hand.length,
      knockedOutBy: player.knockedOutBy,
    })),
    [
      {
        playerId: HOST.playerId,
        seat: 0,
        ready: false,
        status: "active",
        handSize: 0,
        knockedOutBy: null,
      },
      {
        playerId: B.playerId,
        seat: 1,
        ready: false,
        status: "active",
        handSize: 0,
        knockedOutBy: null,
      },
    ],
  );
  assert.equal(
    first.state.players.some((player) => player.playerId === C.playerId),
    false,
  );
  assert.equal(first.state.dealerSeat, null);
  assert.equal(first.state.currentPlayerId, null);
  assert.equal(first.state.direction, 1);
  assert.equal(first.state.activeColor, null);
  assert.deepEqual(first.state.drawPile, []);
  assert.deepEqual(first.state.discardPile, []);
  assert.deepEqual(first.state.mercyReserve, []);
  assert.equal(first.state.pendingDraw, null);
  assert.equal(first.state.rouletteTargetId, null);
  assert.equal(first.state.forcedCardId, null);
  assert.deepEqual(first.state.unoLiabilities, []);
  assert.equal(first.state.winner, null);
  assert.equal(first.state.turnNumber, 0);
  assert.deepEqual(first.events, [
    {
      type: "rematch_started",
      actorPlayerId: HOST.playerId,
      message: "Ada opened a rematch lobby.",
    },
  ]);
  assert.equal(
    projectGameForUser(first.state, HOST.userId).legalActions.canRematch,
    false,
  );

  const replay = transitionGame(first.state, { type: "rematch" }, context);
  assert.equal(replay.replayed, true);
  assert.equal(replay.state, first.state);
  assert.deepEqual(replay.events, []);

  let restarted = first.state;
  restarted = run(restarted, HOST.userId, { type: "set_ready", ready: true });
  restarted = run(restarted, B.userId, { type: "set_ready", ready: true });
  restarted = run(restarted, HOST.userId, { type: "start_game" });
  assert.equal(restarted.phase, "playing");
  assert.deepEqual(
    restarted.players.map((player) => player.hand.length),
    [7, 7],
  );
  assert.equal(allCards(restarted).length, 168);
});

test("rematch rejects non-hosts and games that are not complete", () => {
  const playing = startedGame([HOST, B]);
  expectRuleError(
    () => run(playing, HOST.userId, { type: "rematch" }),
    "REMATCH_NOT_AVAILABLE",
  );

  const completed = completedGameWithEliminatedAndLeftPlayers();
  const snapshot = structuredClone(completed);
  expectRuleError(
    () => run(completed, B.userId, { type: "rematch" }),
    "HOST_ONLY",
  );
  assert.deepEqual(completed, snapshot);
  expectRuleError(
    () => run(completed, HOST.userId, { type: "set_ready", ready: true }),
    "GAME_COMPLETE",
  );
  assert.deepEqual(completed, snapshot);
});

test("completed members leave idempotently through host transfer and final room emptying", () => {
  const completed = completedGameWithEliminatedAndLeftPlayers();
  const completedSnapshot = structuredClone(completed);
  const completedCards = sortedCardIds(completed);
  const winner = structuredClone(completed.winner);
  const hostHandSize = handIds(completed, HOST.playerId).length;
  assert.equal(hostHandSize > 0, true);
  assert.equal(
    projectGameForUser(completed, HOST.userId).legalActions.canLeave,
    true,
  );

  const hostLeaveContext: TransitionContext = {
    actorUserId: HOST.userId,
    commandId: "completed-host-leave",
    now: completed.updatedAt + 10,
  };
  const hostLeave = transitionGame(
    completed,
    { type: "leave_game" },
    hostLeaveContext,
  );

  assert.deepEqual(completed, completedSnapshot);
  assert.equal(hostLeave.replayed, false);
  assert.equal(hostLeave.state.phase, "complete");
  assert.equal(hostLeave.state.hostUserId, B.userId);
  assert.deepEqual(hostLeave.state.winner, winner);
  assert.equal(
    hostLeave.state.players.find((player) => player.playerId === HOST.playerId)
      ?.status,
    "left",
  );
  assert.deepEqual(handIds(hostLeave.state, HOST.playerId), []);
  assert.equal(hostLeave.state.mercyReserve.length >= hostHandSize, true);
  assert.equal(hostLeave.state.currentPlayerId, null);
  assert.equal(hostLeave.state.pendingDraw, null);
  assert.equal(hostLeave.state.rouletteTargetId, null);
  assert.equal(hostLeave.state.forcedCardId, null);
  assert.deepEqual(hostLeave.state.unoLiabilities, []);
  assert.deepEqual(sortedCardIds(hostLeave.state), completedCards);
  assert.deepEqual(hostLeave.events, [
    {
      type: "host_transferred",
      actorPlayerId: HOST.playerId,
      message: "Ben is now the host.",
      data: {
        previousHostPlayerId: HOST.playerId,
        newHostPlayerId: B.playerId,
      },
    },
    {
      type: "player_left",
      actorPlayerId: HOST.playerId,
      message: "Ada left the game.",
    },
  ]);
  assert.equal(
    projectGameForUser(hostLeave.state, HOST.userId).legalActions.canLeave,
    false,
  );
  assert.equal(
    projectGameForUser(hostLeave.state, B.userId).legalActions.canRematch,
    true,
  );

  const hostReplay = transitionGame(
    hostLeave.state,
    { type: "leave_game" },
    hostLeaveContext,
  );
  assert.equal(hostReplay.replayed, true);
  assert.equal(hostReplay.state, hostLeave.state);
  assert.deepEqual(hostReplay.events, []);

  const finalLeaveContext: TransitionContext = {
    actorUserId: B.userId,
    commandId: "completed-final-leave",
    now: hostLeave.state.updatedAt + 10,
  };
  const finalLeave = transitionGame(
    hostLeave.state,
    { type: "leave_game" },
    finalLeaveContext,
  );

  assert.equal(finalLeave.state.phase, "complete");
  assert.equal(
    finalLeave.state.players.every((player) => player.status === "left"),
    true,
  );
  assert.deepEqual(finalLeave.state.winner, winner);
  assert.deepEqual(sortedCardIds(finalLeave.state), completedCards);
  assert.deepEqual(finalLeave.events, [
    {
      type: "player_left",
      actorPlayerId: B.playerId,
      message: "Ben left the game.",
    },
    {
      type: "room_emptied",
      actorPlayerId: B.playerId,
      message: "The final member left the table.",
      data: { reason: "explicit_leave" },
    },
  ]);
  assert.equal(
    projectGameForUser(finalLeave.state, B.userId).legalActions.canLeave,
    false,
  );

  const finalReplay = transitionGame(
    finalLeave.state,
    { type: "leave_game" },
    finalLeaveContext,
  );
  assert.equal(finalReplay.replayed, true);
  assert.equal(finalReplay.state, finalLeave.state);
  assert.deepEqual(finalReplay.events, []);

  const finalSnapshot = structuredClone(finalLeave.state);
  expectRuleError(
    () =>
      transitionGame(finalLeave.state, { type: "leave_game" }, {
        ...finalLeaveContext,
        commandId: "different-final-leave",
        now: finalLeaveContext.now + 1,
      }),
    "PLAYER_NOT_ACTIVE",
  );
  assert.deepEqual(finalLeave.state, finalSnapshot);
});

test("the host can remove an inactive current player with leave-safe turn repair", () => {
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
  assert.equal(state.currentPlayerId, B.playerId);
  assert.equal(state.pendingDraw?.total, 2);
  const targetHandSize = handIds(state, B.playerId).length;
  const cardsBefore = sortedCardIds(state);
  const context: TransitionContext = {
    actorUserId: HOST.userId,
    commandId: "stable-remove-command",
    now: state.updatedAt + 5,
  };

  const result = transitionGame(
    state,
    { type: "remove_inactive_player", targetPlayerId: B.playerId },
    context,
  );

  assert.equal(result.state.phase, "playing");
  assert.equal(
    result.state.players.find((player) => player.playerId === B.playerId)?.status,
    "left",
  );
  assert.deepEqual(handIds(result.state, B.playerId), []);
  assert.equal(result.state.mercyReserve.length >= targetHandSize, true);
  assert.equal(result.state.pendingDraw, null);
  assert.equal(result.state.rouletteTargetId, null);
  assert.equal(result.state.forcedCardId, null);
  assert.equal(result.state.currentPlayerId, C.playerId);
  assert.deepEqual(sortedCardIds(result.state), cardsBefore);
  assert.deepEqual(result.events, [
    {
      type: "inactive_player_removed",
      actorPlayerId: HOST.playerId,
      message: "Ada removed inactive player Ben.",
      data: { targetPlayerId: B.playerId },
    },
  ]);

  const replay = transitionGame(
    result.state,
    { type: "remove_inactive_player", targetPlayerId: B.playerId },
    context,
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.state, result.state);
  assert.deepEqual(replay.events, []);
});

test("inactive-player removal enforces host, membership, active target, and self guards", () => {
  let state = createLobbyState({
    gameId: "removal-guards",
    joinCode: "REMOVE",
    hostUserId: HOST.userId,
    hostPlayerId: HOST.playerId,
    hostDisplayName: HOST.name,
    now: 1,
    seed: 9,
  });
  state = joinLobbyState(state, {
    userId: B.userId,
    playerId: B.playerId,
    displayName: B.name,
    commandId: "join-removal-target",
    now: 2,
  }).state;
  const snapshot = structuredClone(state);

  expectRuleError(
    () =>
      run(state, B.userId, {
        type: "remove_inactive_player",
        targetPlayerId: HOST.playerId,
      }),
    "HOST_ONLY",
  );
  expectRuleError(
    () =>
      run(state, HOST.userId, {
        type: "remove_inactive_player",
        targetPlayerId: HOST.playerId,
      }),
    "CANNOT_REMOVE_SELF",
  );
  expectRuleError(
    () =>
      run(state, HOST.userId, {
        type: "remove_inactive_player",
        targetPlayerId: "missing-player",
      }),
    "PLAYER_NOT_FOUND",
  );
  assert.deepEqual(state, snapshot);

  state = run(state, HOST.userId, {
    type: "remove_inactive_player",
    targetPlayerId: B.playerId,
  });
  assert.equal(state.phase, "lobby");
  assert.equal(
    state.players.find((player) => player.playerId === B.playerId)?.status,
    "left",
  );
  expectRuleError(
    () =>
      run(state, HOST.userId, {
        type: "remove_inactive_player",
        targetPlayerId: B.playerId,
      }),
    "PLAYER_NOT_ACTIVE",
  );
});

test("a final lobby leave emits an idempotent empty-room transition", () => {
  const state = createLobbyState({
    gameId: "abandoned-game",
    joinCode: "CLOSE1",
    hostUserId: HOST.userId,
    hostPlayerId: HOST.playerId,
    hostDisplayName: HOST.name,
    now: 1,
    seed: 7,
  });

  const context: TransitionContext = {
    actorUserId: HOST.userId,
    commandId: "final-lobby-leave",
    now: state.updatedAt + 1,
  };
  const result = transitionGame(state, { type: "leave_game" }, context);

  assert.equal(result.state.phase, "complete");
  assert.equal(result.state.players[0].status, "left");
  assert.equal(projectGameForUser(result.state, HOST.userId).phase, "complete");
  assert.deepEqual(result.events, [
    {
      type: "player_left",
      actorPlayerId: HOST.playerId,
      message: "Ada left the game.",
    },
    {
      type: "room_emptied",
      actorPlayerId: HOST.playerId,
      message: "The final member left the table.",
      data: { reason: "explicit_leave" },
    },
  ]);

  const replay = transitionGame(result.state, { type: "leave_game" }, context);
  assert.equal(replay.replayed, true);
  assert.equal(replay.state, result.state);
  assert.deepEqual(replay.events, []);

  expectRuleError(
    () =>
      transitionGame(result.state, { type: "leave_game" }, {
        ...context,
        commandId: "second-lobby-leave",
        now: context.now + 1,
      }),
    "PLAYER_NOT_ACTIVE",
  );
});

function completedGameWithEliminatedAndLeftPlayers(): GameState {
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
  setHandSize(state, B.playerId, 24);
  state = run(state, C.userId, { type: "leave_game" });
  state = run(state, HOST.userId, {
    type: "play_card",
    cardId: plusTwo.id,
  });
  state = run(state, B.userId, { type: "accept_penalty" });
  assert.equal(state.phase, "complete");
  assert.equal(
    state.players.find((player) => player.playerId === B.playerId)?.status,
    "eliminated",
  );
  assert.equal(
    state.players.find((player) => player.playerId === C.playerId)?.status,
    "left",
  );
  return state;
}

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
