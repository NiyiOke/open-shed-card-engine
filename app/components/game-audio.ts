import type { Card, CardColor, CardKind } from "../../lib/game/types";

const SETTINGS_KEY = "open-shed-audio-settings-v1";
const MAX_AUDIO_PENALTY = 999;
const DEFAULT_SETTINGS: AudioSettings = Object.freeze({
  enabled: false,
  volume: 65,
  spokenCallouts: true,
});

export type AudioSettings = {
  enabled: boolean;
  volume: number;
  spokenCallouts: boolean;
};

export type AudioCapabilities = {
  effects: boolean;
  speech: boolean;
};

export type AudioDebugState = {
  enabled: boolean;
  unlocked: boolean;
  supported: boolean;
  speechSupported: boolean;
  lastCue: string | null;
  lastCallout: string | null;
  lastRevision: number | null;
};

export type TurnAudioNotification = {
  revision: number;
  isSelfTurn: boolean;
  phase: "lobby" | "playing" | "complete";
  visible: boolean;
  connected: boolean;
  hydrating?: boolean;
};

type AudioEventBase = {
  revision: number;
  dedupeId: string;
  visible: boolean;
  connected: boolean;
  hydrating?: boolean;
};

export type GameAudioEvent =
  | (AudioEventBase & {
      kind: "card_played";
      card: Card;
      activeColor?: CardColor | null;
    })
  | (AudioEventBase & { kind: "penalty"; amount: number })
  | (AudioEventBase & { kind: "draw" })
  | (AudioEventBase & { kind: "action"; action: string })
  | (AudioEventBase & { kind: "uno"; caught?: boolean })
  | (AudioEventBase & { kind: "mercy" })
  | (AudioEventBase & { kind: "win" })
  | (AudioEventBase & { kind: "game_start" });

export type CardAudioClass =
  | "card_number"
  | "card_action"
  | "card_draw"
  | "card_wild";

export type EventAudioClass =
  | CardAudioClass
  | "action"
  | "draw"
  | "game_start"
  | "mercy"
  | "penalty"
  | "uno"
  | "win";

export type AudioTransitionPolicy = {
  connected: boolean;
  enabled: boolean;
  hydrating?: boolean;
  isSelfTurn?: boolean;
  kind: "event" | "turn";
  phase?: "lobby" | "playing" | "complete";
  unlocked: boolean;
  visible: boolean;
};

export type GameAudioController = {
  getSettings: () => AudioSettings;
  getCapabilities: () => AudioCapabilities;
  getDebugState: () => AudioDebugState;
  setEnabled: (enabled: boolean) => Promise<boolean>;
  setVolume: (volume: number) => void;
  setSpokenCallouts: (enabled: boolean) => void;
  resumeFromGesture: () => Promise<boolean>;
  preview: () => Promise<boolean>;
  notifyTurn: (notification: TurnAudioNotification) => void;
  notifyEvent: (event: GameAudioEvent) => void;
  resetTransitionHistory: () => void;
  cancel: () => void;
  dispose: () => Promise<void>;
};

type AudioWindow = Window & {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
  SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance;
};

export function createGameAudioController(): GameAudioController {
  const browser = typeof window === "undefined" ? null : (window as AudioWindow);
  const AudioContextConstructor = browser?.AudioContext ?? browser?.webkitAudioContext;
  const UtteranceConstructor =
    browser?.SpeechSynthesisUtterance ??
    (typeof SpeechSynthesisUtterance === "undefined"
      ? undefined
      : SpeechSynthesisUtterance);
  const capabilities: AudioCapabilities = {
    effects: Boolean(AudioContextConstructor),
    speech: Boolean(browser?.speechSynthesis && UtteranceConstructor),
  };
  let settings = readSettings(browser);
  let context: AudioContext | null = null;
  let disposed = false;
  const activeOscillators = new Set<OscillatorNode>();
  const dedupeIds = new Set<string>();
  const debug: AudioDebugState = {
    enabled: settings.enabled,
    unlocked: false,
    supported: capabilities.effects || capabilities.speech,
    speechSupported: capabilities.speech,
    lastCue: null,
    lastCallout: null,
    lastRevision: null,
  };

  const persist = () => {
    try {
      browser?.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // Private browsing and storage policies must not break the table.
    }
  };

  const remember = (dedupeId: string): boolean => {
    const safeId = dedupeId.trim().slice(0, 96);
    if (dedupeIds.has(safeId)) return false;
    dedupeIds.add(safeId);
    if (dedupeIds.size > 128) {
      const oldest = dedupeIds.values().next().value;
      if (oldest) dedupeIds.delete(oldest);
    }
    return true;
  };

  const ensureContext = (): AudioContext | null => {
    if (disposed || !AudioContextConstructor) return null;
    if (!context) {
      try {
        context = new AudioContextConstructor();
      } catch {
        context = null;
      }
    }
    return context;
  };

  const playTone = (
    frequency: number,
    delay: number,
    duration: number,
    shape: OscillatorType,
    peak = 0.12,
    endFrequency?: number,
  ): boolean => {
    const audioContext = context;
    if (
      !audioContext ||
      audioContext.state !== "running" ||
      settings.volume <= 0 ||
      disposed
    ) return false;
    try {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const start = audioContext.currentTime + delay;
      const end = start + duration;
      const volume = settings.volume / 100;
      oscillator.type = shape;
      oscillator.frequency.setValueAtTime(frequency, start);
      if (endFrequency) {
        oscillator.frequency.exponentialRampToValueAtTime(endFrequency, end);
      }
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * volume), start + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      activeOscillators.add(oscillator);
      oscillator.onended = () => activeOscillators.delete(oscillator);
      oscillator.start(start);
      oscillator.stop(end + 0.015);
      return true;
    } catch {
      return false;
    }
  };

  const cue = (kind: EventAudioClass | "turn", revision: number | null): boolean => {
    let played = false;
    if (kind === "turn") {
      played = playTone(587, 0, 0.12, "sine", 0.13) || played;
      played = playTone(880, 0.13, 0.18, "sine", 0.12) || played;
    } else if (kind === "card_number") {
      played = playTone(210, 0, 0.09, "triangle", 0.14, 120) || played;
      played = playTone(720, 0.045, 0.06, "square", 0.035, 520) || played;
    } else if (kind === "card_action") {
      played = playTone(250, 0, 0.1, "triangle", 0.14, 135) || played;
      played = playTone(940, 0.055, 0.1, "square", 0.04, 540) || played;
    } else if (kind === "card_draw") {
      played = playTone(165, 0, 0.15, "sawtooth", 0.09, 88) || played;
      played = playTone(360, 0.1, 0.09, "triangle", 0.065, 220) || played;
    } else if (kind === "card_wild") {
      played = playTone(392, 0, 0.16, "sine", 0.08) || played;
      played = playTone(523, 0.07, 0.16, "sine", 0.08) || played;
      played = playTone(659, 0.14, 0.2, "sine", 0.075) || played;
    } else if (kind === "penalty") {
      played = playTone(180, 0, 0.22, "sawtooth", 0.08, 72) || played;
    } else if (kind === "win") {
      played = playTone(523, 0, 0.16, "sine", 0.11) || played;
      played = playTone(659, 0.13, 0.16, "sine", 0.11) || played;
      played = playTone(784, 0.26, 0.24, "sine", 0.12) || played;
    } else if (kind === "mercy") {
      played = playTone(130, 0, 0.25, "triangle", 0.11, 65) || played;
    } else {
      played = playTone(330, 0, 0.1, "triangle", 0.08, 420) || played;
    }
    if (played) {
      debug.lastCue = kind;
      debug.lastRevision = revision;
    }
    return played;
  };

  const speak = (callout: string | null, revision: number | null): boolean => {
    if (
      !callout ||
      !settings.spokenCallouts ||
      settings.volume <= 0 ||
      !capabilities.speech ||
      !browser?.speechSynthesis ||
      !UtteranceConstructor ||
      disposed
    ) return false;
    try {
      browser.speechSynthesis.cancel();
      const utterance = new UtteranceConstructor(callout);
      utterance.volume = settings.volume / 100;
      utterance.rate = 0.92;
      utterance.pitch = 0.96;
      browser.speechSynthesis.speak(utterance);
      debug.lastCallout = callout;
      debug.lastRevision = revision;
      return true;
    } catch {
      return false;
    }
  };

  const cancel = () => {
    for (const oscillator of activeOscillators) {
      try {
        oscillator.stop();
      } catch {
        // A one-shot oscillator may already have ended.
      }
    }
    activeOscillators.clear();
    try {
      browser?.speechSynthesis?.cancel();
    } catch {
      // Speech cancellation is best effort.
    }
  };

  const resetTransitionHistory = () => {
    // A table boundary must stop anything scheduled by the table being left,
    // not just forget its revision keys.
    cancel();
    dedupeIds.clear();
    debug.lastCue = null;
    debug.lastCallout = null;
    debug.lastRevision = null;
  };

  const resumeFromGesture = async (): Promise<boolean> => {
    if (disposed || !settings.enabled || !debug.supported) return false;
    let effectsUnlocked = !capabilities.effects;
    const audioContext = ensureContext();
    if (audioContext) {
      try {
        if (audioContext.state !== "running") await audioContext.resume();
        effectsUnlocked = audioContext.state === "running";
      } catch {
        effectsUnlocked = false;
      }
    }
    debug.enabled = settings.enabled;
    debug.unlocked =
      (capabilities.effects && effectsUnlocked) || capabilities.speech;
    return debug.unlocked;
  };

  const setEnabled = async (enabled: boolean): Promise<boolean> => {
    if (disposed) return false;
    if (enabled && !debug.supported) return false;
    settings = { ...settings, enabled };
    debug.enabled = enabled;
    persist();
    if (!enabled) {
      cancel();
      debug.unlocked = false;
      if (context?.state === "running") {
        try {
          await context.suspend();
        } catch {
          // The preference still remains safely muted.
        }
      }
      return false;
    }
    return resumeFromGesture();
  };

  const setVolume = (volume: number) => {
    settings = { ...settings, volume: normalizeVolume(volume) };
    if (settings.volume === 0) cancel();
    persist();
  };

  const setSpokenCallouts = (enabled: boolean) => {
    settings = { ...settings, spokenCallouts: Boolean(enabled) };
    if (!enabled) {
      try {
        browser?.speechSynthesis?.cancel();
      } catch {
        // The toggle still applies to future callouts.
      }
    }
    persist();
  };

  const preview = async (): Promise<boolean> => {
    if (!settings.enabled || !(await resumeFromGesture())) return false;
    const played = cue("card_number", null);
    const spoken = speak("Blue two", null);
    return played || spoken;
  };

  const notifyTurn = (notification: TurnAudioNotification) => {
    if (
      disposed ||
      !shouldPlayAudioTransition({
        connected: notification.connected,
        enabled: settings.enabled,
        hydrating: notification.hydrating,
        isSelfTurn: notification.isSelfTurn,
        kind: "turn",
        phase: notification.phase,
        unlocked: debug.unlocked,
        visible: notification.visible,
      }) ||
      !remember(`turn:${notification.revision}`)
    ) return;
    // The short chime is intentionally allowed in a background tab.
    cue("turn", notification.revision);
  };

  const notifyEvent = (event: GameAudioEvent) => {
    if (
      disposed ||
      !shouldPlayAudioTransition({
        connected: event.connected,
        enabled: settings.enabled,
        hydrating: event.hydrating,
        kind: "event",
        unlocked: debug.unlocked,
        visible: event.visible,
      })
    ) return;

    const audioClass = getEventAudioClass(event);
    if (
      !audioClass ||
      !remember(event.dedupeId || `${event.kind}:${event.revision}`)
    ) return;
    cue(audioClass, event.revision);
    speak(getEventCallout(event), event.revision);
  };

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    cancel();
    debug.unlocked = false;
    if (context && context.state !== "closed") {
      try {
        await context.close();
      } catch {
        // Disposal is best effort during navigation.
      }
    }
    context = null;
  };

  return {
    getSettings: () => ({ ...settings }),
    getCapabilities: () => ({ ...capabilities }),
    getDebugState: () => ({ ...debug }),
    setEnabled,
    setVolume,
    setSpokenCallouts,
    resumeFromGesture,
    preview,
    notifyTurn,
    notifyEvent,
    resetTransitionHistory,
    cancel,
    dispose,
  };
}

export function getEventAudioClass(event: GameAudioEvent): EventAudioClass | null {
  switch (event.kind) {
    case "card_played":
      return getCardAudioClass(event.card);
    case "penalty":
      return validPenaltyAmount(event.amount) === null ? null : "penalty";
    case "draw":
      return "draw";
    case "uno":
      return "uno";
    case "mercy":
      return "mercy";
    case "win":
      return "win";
    case "game_start":
      return "game_start";
    case "action":
      return safeActionCallout(event.action) ? "action" : null;
    default:
      return null;
  }
}

export function getEventCallout(event: GameAudioEvent): string | null {
  switch (event.kind) {
    case "card_played":
      return getCardCallout(event.card, event.activeColor);
    case "penalty": {
      const amount = validPenaltyAmount(event.amount);
      return amount === null ? null : `Draw ${amount}`;
    }
    case "draw":
      return null;
    case "uno":
      return event.caught === true ? "UNO caught" : "UNO";
    case "mercy":
      return "Mercy knockout";
    case "win":
      return "Round complete";
    case "game_start":
      return "Game start";
    case "action":
      return safeActionCallout(event.action);
    default:
      return null;
  }
}

export function shouldPlayAudioTransition(input: AudioTransitionPolicy): boolean {
  if (
    !input.enabled ||
    !input.unlocked ||
    !input.connected ||
    input.hydrating
  ) return false;
  if (input.kind === "event") return input.visible;
  return input.phase === "playing" && input.isSelfTurn === true;
}

export function getCardAudioClass(card: Card): CardAudioClass | null {
  if (!isValidRuntimeCard(card)) return null;
  if (card.kind === "number") return "card_number";
  if (card.color === null) return "card_wild";
  if (card.kind === "draw_two" || card.kind === "draw_four") return "card_draw";
  return "card_action";
}

export function getCardCallout(
  card: Card,
  activeColor?: CardColor | null,
): string | null {
  if (!isValidRuntimeCard(card)) return null;
  const color = card.color ? capitalize(card.color) : "Wild";
  if (card.kind === "number") {
    return `${color} ${numberWord(card.number as number)}`;
  }
  const kind = CARD_KIND_CALLOUTS[card.kind];
  if (card.color) return `${color} ${kind}`;
  // Roulette's target chooses the color later; the previous active color is stale.
  if (card.kind === "wild_color_roulette") return kind;
  return isCardColor(activeColor)
    ? `${kind}. ${capitalize(activeColor)} active`
    : kind;
}

const CARD_KIND_CALLOUTS: Record<Exclude<CardKind, "number">, string> = {
  draw_two: "Draw two",
  draw_four: "Draw four",
  skip: "Skip",
  reverse: "Reverse",
  discard_all: "Discard all",
  skip_everyone: "Skip everyone",
  wild_reverse_draw_four: "Wild reverse draw four",
  wild_draw_six: "Wild draw six",
  wild_draw_ten: "Wild draw ten",
  wild_color_roulette: "Wild color roulette",
};

function safeActionCallout(action: string): string | null {
  switch (action) {
    case "reverse":
      return "Reverse";
    case "skip":
      return "Skip";
    case "skip_everyone":
      return "Skip everyone";
    case "discard_all":
      return "Discard all";
    default:
      return null;
  }
}

function isValidRuntimeCard(card: Card): boolean {
  if (!card || typeof card !== "object" || typeof card.id !== "string") return false;
  if (card.kind === "number") {
    const number = card.number;
    return isCardColor(card.color) &&
      number !== null &&
      Number.isInteger(number) &&
      number >= 0 &&
      number <= 9;
  }
  if (!Object.prototype.hasOwnProperty.call(CARD_KIND_CALLOUTS, card.kind)) return false;
  if (card.number !== null) return false;
  return card.kind.startsWith("wild_")
    ? card.color === null
    : isCardColor(card.color);
}

function isCardColor(value: unknown): value is CardColor {
  return value === "red" || value === "yellow" || value === "green" || value === "blue";
}

function validPenaltyAmount(value: number): number | null {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_AUDIO_PENALTY
    ? value
    : null;
}

function readSettings(browser: AudioWindow | null): AudioSettings {
  try {
    const raw = browser?.localStorage?.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const value = JSON.parse(raw) as Partial<AudioSettings>;
    return {
      enabled: value.enabled === true,
      volume: normalizeVolume(value.volume ?? DEFAULT_SETTINGS.volume),
      spokenCallouts:
        typeof value.spokenCallouts === "boolean"
          ? value.spokenCallouts
          : DEFAULT_SETTINGS.spokenCallouts,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function normalizeVolume(volume: number): number {
  if (!Number.isFinite(volume)) return DEFAULT_SETTINGS.volume;
  return Math.max(0, Math.min(100, Math.round(volume)));
}

function numberWord(value: number): string {
  return ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][value] ?? String(value);
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
