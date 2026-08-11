import assert from "node:assert/strict";
import test from "node:test";
import {
  createGameAudioController,
  getCardAudioClass,
  getCardCallout,
  getEventAudioClass,
  getEventCallout,
  shouldPlayAudioTransition,
  type GameAudioEvent,
} from "../app/components/game-audio";
import type { Card, CardKind } from "../lib/game/types";

test("maps public cards to distinct sound classes and bounded callouts", () => {
  assert.equal(getCardAudioClass(makeCard("number", "blue", 2)), "card_number");
  assert.equal(getCardCallout(makeCard("number", "blue", 2)), "Blue two");

  assert.equal(getCardAudioClass(makeCard("reverse", "red")), "card_action");
  assert.equal(getCardCallout(makeCard("reverse", "red")), "Red Reverse");

  assert.equal(getCardAudioClass(makeCard("draw_four", "yellow")), "card_draw");
  assert.equal(getCardCallout(makeCard("draw_four", "yellow")), "Yellow Draw four");

  assert.equal(getCardAudioClass(makeCard("wild_draw_six", null)), "card_wild");
  assert.equal(
    getCardCallout(makeCard("wild_draw_six", null), "green"),
    "Wild draw six. Green active",
  );
});

test("roulette never announces the previous active color", () => {
  assert.equal(
    getCardCallout(makeCard("wild_color_roulette", null), "red"),
    "Wild color roulette",
  );
});

test("card speech mapping fails closed for malformed runtime values", () => {
  const malformed = [
    { id: "bad-color", kind: "number", color: "purple", number: 2 },
    { id: "bad-number", kind: "number", color: "blue", number: 42 },
    { id: "bad-kind", kind: "speak_my_payload", color: "red", number: null },
    { id: "bad-wild", kind: "wild_draw_six", color: "blue", number: null },
  ];
  for (const value of malformed) {
    const card = value as unknown as Card;
    assert.equal(getCardAudioClass(card), null);
    assert.equal(getCardCallout(card), null);
  }
});

test("event mapping rejects arbitrary actions and invalid penalties", () => {
  const base = {
    revision: 8,
    dedupeId: "event:8",
    visible: true,
    connected: true,
  };
  const invalidPenalty = {
    ...base,
    kind: "penalty",
    amount: Number.NaN,
  } as GameAudioEvent;
  assert.equal(getEventAudioClass(invalidPenalty), null);
  assert.equal(getEventCallout(invalidPenalty), null);
  for (const amount of [1.1, 3.9, 999.9, 1_000]) {
    const malformedPenalty = {
      ...base,
      kind: "penalty",
      amount,
    } as GameAudioEvent;
    assert.equal(getEventAudioClass(malformedPenalty), null);
    assert.equal(getEventCallout(malformedPenalty), null);
  }

  const unknownAction = {
    ...base,
    kind: "action",
    action: "Read the private hand aloud",
  } as GameAudioEvent;
  assert.equal(getEventAudioClass(unknownAction), null);
  assert.equal(getEventCallout(unknownAction), null);

  for (const action of ["constructor", "toString", "__proto__"]) {
    const prototypeCanary = {
      ...base,
      kind: "action",
      action,
    } as GameAudioEvent;
    assert.equal(getEventAudioClass(prototypeCanary), null);
    assert.equal(getEventCallout(prototypeCanary), null);
  }

  const penalty = { ...base, kind: "penalty", amount: 10 } as GameAudioEvent;
  assert.equal(getEventAudioClass(penalty), "penalty");
  assert.equal(getEventCallout(penalty), "Draw 10");
});

test("transition policy allows only a hidden self-turn chime", () => {
  const common = {
    connected: true,
    enabled: true,
    hydrating: false,
    unlocked: true,
    visible: false,
  };
  assert.equal(
    shouldPlayAudioTransition({ ...common, kind: "event" }),
    false,
  );
  assert.equal(
    shouldPlayAudioTransition({
      ...common,
      kind: "turn",
      isSelfTurn: true,
      phase: "playing",
    }),
    true,
  );
  assert.equal(
    shouldPlayAudioTransition({
      ...common,
      kind: "turn",
      isSelfTurn: false,
      phase: "playing",
    }),
    false,
  );
  assert.equal(
    shouldPlayAudioTransition({
      ...common,
      hydrating: true,
      kind: "turn",
      isSelfTurn: true,
      phase: "playing",
    }),
    false,
  );
});

test("unsupported environments remain muted without throwing", async () => {
  const controller = createGameAudioController();
  assert.deepEqual(controller.getCapabilities(), { effects: false, speech: false });
  assert.equal(controller.getDebugState().unlocked, false);
  assert.equal(await controller.setEnabled(true), false);
  assert.equal(controller.getSettings().enabled, false);
  assert.equal(await controller.preview(), false);
  assert.doesNotThrow(() => controller.resetTransitionHistory());
  await controller.dispose();
});

test("a persisted preference stays ready without autoplay or context creation", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let contextsCreated = 0;
  class FakeAudioContext {
    constructor() {
      contextsCreated += 1;
    }
  }
  const fakeWindow = {
    AudioContext: FakeAudioContext,
    localStorage: {
      getItem: () => JSON.stringify({
        enabled: true,
        volume: 55,
        spokenCallouts: false,
      }),
      setItem: () => undefined,
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: fakeWindow,
  });

  try {
    const controller = createGameAudioController();
    assert.equal(controller.getSettings().enabled, true);
    assert.equal(controller.getSettings().volume, 55);
    assert.equal(controller.getDebugState().unlocked, false);
    assert.equal(contextsCreated, 0);
    await controller.dispose();
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("an explicit gesture unlocks procedural effects and revision dedupe", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let contextsCreated = 0;
  let oscillatorsCreated = 0;
  let resumeCalls = 0;
  let suspendCalls = 0;
  let closeCalls = 0;

  class FakeAudioParam {
    setValueAtTime() {}
    exponentialRampToValueAtTime() {}
  }
  class FakeOscillator {
    type = "sine";
    frequency = new FakeAudioParam();
    onended: (() => void) | null = null;
    connect() {}
    start() {}
    stop() {}
  }
  class FakeGain {
    gain = new FakeAudioParam();
    connect() {}
  }
  class FakeAudioContext {
    currentTime = 2;
    destination = {};
    state = "suspended";

    constructor() {
      contextsCreated += 1;
    }

    createOscillator() {
      oscillatorsCreated += 1;
      return new FakeOscillator();
    }

    createGain() {
      return new FakeGain();
    }

    async resume() {
      resumeCalls += 1;
      this.state = "running";
    }

    async suspend() {
      suspendCalls += 1;
      this.state = "suspended";
    }

    async close() {
      closeCalls += 1;
      this.state = "closed";
    }
  }

  const fakeWindow = {
    AudioContext: FakeAudioContext,
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: fakeWindow,
  });

  try {
    const controller = createGameAudioController();
    assert.equal(contextsCreated, 0, "construction must remain silent");
    assert.equal(await controller.setEnabled(true), true);
    assert.equal(contextsCreated, 1);
    assert.equal(resumeCalls, 1);

    assert.equal(await controller.preview(), true);
    assert.equal(oscillatorsCreated, 2);
    assert.equal(controller.getDebugState().lastCue, "card_number");

    const wild = {
      revision: 7,
      dedupeId: "card_played:7",
      visible: true,
      connected: true,
      kind: "card_played",
      card: makeCard("wild_draw_six", null),
      activeColor: "green",
    } as GameAudioEvent;
    controller.notifyEvent(wild);
    assert.equal(oscillatorsCreated, 5);
    assert.equal(controller.getDebugState().lastCue, "card_wild");
    assert.equal(controller.getDebugState().lastRevision, 7);
    controller.notifyEvent(wild);
    assert.equal(oscillatorsCreated, 5, "the same revision cue must not replay");

    controller.notifyTurn({
      revision: 7,
      isSelfTurn: true,
      phase: "playing",
      visible: false,
      connected: true,
    });
    assert.equal(oscillatorsCreated, 7, "a hidden table may emit only its self-turn chime");
    controller.setVolume(140);
    assert.equal(controller.getSettings().volume, 100);

    await controller.setEnabled(false);
    assert.equal(suspendCalls, 1);
    assert.equal(controller.getDebugState().unlocked, false);
    await controller.dispose();
    assert.equal(closeCalls, 1);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("resetting transition history clears debug state and cross-table dedupe", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const spoken: string[] = [];
  let cancelled = 0;
  const stored = new Map<string, string>();
  class FakeUtterance {
    volume = 1;
    rate = 1;
    pitch = 1;

    constructor(readonly text: string) {}
  }
  const fakeWindow = {
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    },
    speechSynthesis: {
      cancel: () => {
        cancelled += 1;
      },
      speak: (utterance: FakeUtterance) => spoken.push(utterance.text),
    },
    SpeechSynthesisUtterance: FakeUtterance,
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: fakeWindow,
  });

  try {
    const controller = createGameAudioController();
    assert.equal(await controller.setEnabled(true), true);
    const event = {
      revision: 4,
      dedupeId: "card_played:4",
      visible: true,
      connected: true,
      kind: "card_played",
      card: makeCard("number", "blue", 2),
    } as GameAudioEvent;
    controller.notifyEvent(event);
    assert.equal(controller.getDebugState().lastCallout, "Blue two");
    assert.equal(controller.getDebugState().lastRevision, 4);
    assert.deepEqual(spoken, ["Blue two"]);
    const cancelsBeforeBoundary = cancelled;

    controller.resetTransitionHistory();
    assert.equal(cancelled, cancelsBeforeBoundary + 1);
    assert.equal(controller.getDebugState().lastCallout, null);
    assert.equal(controller.getDebugState().lastCue, null);
    assert.equal(controller.getDebugState().lastRevision, null);
    controller.notifyEvent(event);
    assert.deepEqual(spoken, ["Blue two", "Blue two"]);
    await controller.dispose();
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

function makeCard(
  kind: CardKind,
  color: Card["color"],
  number: number | null = null,
): Card {
  return { id: `test-${kind}`, kind, color, number };
}
