export const GAME_PROTOCOL_VERSION = 1;
export const RULES_VERSION = "merciless-baseline-v1";

export const COLORS = ["red", "yellow", "green", "blue"] as const;
export type CardColor = (typeof COLORS)[number];

export type CardKind =
  | "number"
  | "draw_two"
  | "draw_four"
  | "skip"
  | "reverse"
  | "discard_all"
  | "skip_everyone"
  | "wild_reverse_draw_four"
  | "wild_draw_six"
  | "wild_draw_ten"
  | "wild_color_roulette";

export type Card = {
  id: string;
  kind: CardKind;
  color: CardColor | null;
  number: number | null;
};

export type PlayerStatus = "active" | "eliminated" | "left";

export type PlayerState = {
  playerId: string;
  userId: string;
  displayName: string;
  seat: number;
  ready: boolean;
  status: PlayerStatus;
  hand: Card[];
  knockedOutBy: string | null;
};

export type PendingDraw = {
  total: number;
  minimum: 2 | 4 | 6 | 10;
  sourcePlayerId: string;
};

export type UnoLiability = {
  playerId: string;
  openedRevision: number;
};

export type GameWinner = {
  playerId: string;
  reason: "empty_hand" | "last_active";
};

export type ProcessedCommand = {
  actorUserId: string;
  commandId: string;
};

export type RulesProfile = {
  version: typeof RULES_VERSION;
  finalCardWinsBeforeExternalEffects: true;
  mercyTiming: "immediate_at_25";
  wildContinuingColor: "actor_except_roulette_target";
  rouletteMissingColor: "draw_all_and_finish";
  forcedDraw: "until_playable_then_must_play";
};

export type GameState = {
  schemaVersion: 1;
  protocolVersion: typeof GAME_PROTOCOL_VERSION;
  rules: RulesProfile;
  gameId: string;
  joinCode: string;
  hostUserId: string;
  phase: "lobby" | "playing" | "complete";
  players: PlayerState[];
  dealerSeat: number | null;
  currentPlayerId: string | null;
  direction: 1 | -1;
  activeColor: CardColor | null;
  drawPile: Card[];
  discardPile: Card[];
  mercyReserve: Card[];
  pendingDraw: PendingDraw | null;
  rouletteTargetId: string | null;
  forcedCardId: string | null;
  unoLiabilities: UnoLiability[];
  winner: GameWinner | null;
  revision: number;
  turnNumber: number;
  /** Null selects production CSPRNG shuffles; numbers are test fixtures only. */
  rngState: number | null;
  processedCommands: ProcessedCommand[];
  createdAt: number;
  updatedAt: number;
};

export type GameCommand =
  | { type: "set_ready"; ready: boolean }
  | { type: "start_game" }
  | {
      type: "play_card";
      cardId: string;
      chosenColor?: CardColor;
      swapTargetId?: string;
      declareUno?: boolean;
    }
  | { type: "draw_until_playable" }
  | { type: "accept_penalty" }
  | { type: "choose_roulette_color"; color: CardColor }
  | { type: "declare_uno" }
  | { type: "catch_uno"; offenderPlayerId: string }
  | { type: "leave_game" };

export type CommandEnvelope = {
  commandId: string;
  expectedRevision: number;
  command: GameCommand;
};

export type GameEvent = {
  type: string;
  actorPlayerId: string | null;
  message: string;
  data?: Record<string, string | number | boolean | null>;
};

export type TransitionContext = {
  actorUserId: string;
  commandId: string;
  now: number;
};

export type TransitionResult = {
  state: GameState;
  events: GameEvent[];
  replayed: boolean;
};

export type LegalActions = {
  canSetReady: boolean;
  canStart: boolean;
  playableCardIds: string[];
  canDrawUntilPlayable: boolean;
  canAcceptPenalty: boolean;
  canChooseRouletteColor: boolean;
  canDeclareUno: boolean;
  catchablePlayerIds: string[];
  canLeave: boolean;
};

export type PlayerView = Omit<PlayerState, "userId" | "hand"> & {
  cardCount: number;
  isSelf: boolean;
};

export type GameView = {
  gameId: string;
  joinCode: string;
  phase: GameState["phase"];
  rulesVersion: string;
  revision: number;
  turnNumber: number;
  direction: GameState["direction"];
  activeColor: GameState["activeColor"];
  currentPlayerId: string | null;
  currentPlayerName: string | null;
  topDiscard: Card | null;
  drawPileCount: number;
  mercyReserveCount: number;
  pendingDraw: PendingDraw | null;
  rouletteTargetId: string | null;
  forcedCardId: string | null;
  unoLiabilities: UnoLiability[];
  winner: (GameWinner & { displayName: string }) | null;
  players: PlayerView[];
  hand: Card[];
  legalActions: LegalActions;
  isHost: boolean;
};

export const BASELINE_RULES: RulesProfile = {
  version: RULES_VERSION,
  finalCardWinsBeforeExternalEffects: true,
  mercyTiming: "immediate_at_25",
  wildContinuingColor: "actor_except_roulette_target",
  rouletteMissingColor: "draw_all_and_finish",
  forcedDraw: "until_playable_then_must_play",
};
