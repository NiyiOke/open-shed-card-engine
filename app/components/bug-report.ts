import {
  GAME_PROTOCOL_VERSION,
  RULES_VERSION,
  type CardColor,
  type GameView,
} from "../../lib/game/types";
import {
  APP_RELEASE_IDENTITY,
  APP_VERSION,
} from "../../lib/app-version";

export const BUG_REPORT_REPOSITORY_URL =
  "https://github.com/NiyiOke/open-shed-card-engine";
export const BUG_REPORT_DESCRIPTION_MIN_LENGTH = 10;
export const BUG_REPORT_DESCRIPTION_MAX_LENGTH = 600;
export const BUG_REPORT_MAX_URL_LENGTH = 4_096;

export const BUG_REPORT_CATEGORIES = [
  { id: "turn_stuck", label: "Turn seems stuck" },
  { id: "card_behavior", label: "Card behaved unexpectedly" },
  { id: "connection", label: "Connection or rejoining" },
  { id: "display_accessibility", label: "Display or accessibility" },
  { id: "other", label: "Something else" },
] as const;

export type BugReportCategory = (typeof BUG_REPORT_CATEGORIES)[number]["id"];
export type BugReportPhase = GameView["phase"] | "lobby-browser";
export type BugReportConnection = "live" | "syncing" | "reconnecting" | "offline";
export type BugReportViewport = "narrow" | "mobile" | "tablet" | "desktop";
export type SafeBugReportLegalAction =
  | "set_ready"
  | "start_game"
  | "play_card"
  | "draw_until_playable"
  | "accept_penalty"
  | "choose_roulette_color"
  | "declare_uno"
  | "catch_uno"
  | "rematch"
  | "leave_game";

export type SafeBugReportLegalActionInput = {
  canSetReady: boolean;
  canStart: boolean;
  canPlayCard: boolean;
  canDrawUntilPlayable: boolean;
  canAcceptPenalty: boolean;
  canChooseRouletteColor: boolean;
  canDeclareUno: boolean;
  canCatchUno: boolean;
  canRematch: boolean;
  canLeave: boolean;
};

export const SAFE_BUG_REPORT_EVENT_KINDS: ReadonlySet<string> = new Set([
  "player_joined",
  "ready_changed",
  "game_started",
  "discard_all",
  "card_played",
  "hands_rotated",
  "hands_swapped",
  "draw_penalty_stacked",
  "cards_drawn_until_playable",
  "draw_penalty_accepted",
  "roulette_resolved",
  "uno_declared",
  "uno_caught",
  "host_transferred",
  "player_left",
  "room_emptied",
  "inactive_player_removed",
  "rematch_started",
  "player_eliminated",
  "game_won",
  "public_listing_published",
  "room_closed",
]);

const SAFE_BUG_REPORT_LEGAL_ACTIONS = new Set<SafeBugReportLegalAction>([
  "set_ready",
  "start_game",
  "play_card",
  "draw_until_playable",
  "accept_penalty",
  "choose_roulette_color",
  "declare_uno",
  "catch_uno",
  "rematch",
  "leave_game",
]);

export type SafeBugReportDiagnostics = {
  appVersion: typeof APP_VERSION;
  buildId: string | null;
  phase: BugReportPhase;
  revision: number | null;
  rulesVersion: typeof RULES_VERSION;
  protocolVersion: typeof GAME_PROTOCOL_VERSION;
  connection: BugReportConnection;
  currentTurnIsSelf: boolean | null;
  activeColor: CardColor | null;
  pendingDraw: { total: number; minimum: number } | null;
  direction: "clockwise" | "counterclockwise" | null;
  playerCount: number;
  viewportBucket: BugReportViewport;
  rouletteChoice: "none" | "self" | "other";
  legalActions: SafeBugReportLegalAction[];
  recentEventKinds: string[];
};

export type BugReportDiagnosticInput = Omit<
  SafeBugReportDiagnostics,
  | "appVersion"
  | "buildId"
  | "rulesVersion"
  | "protocolVersion"
  | "recentEventKinds"
> & {
  recentEventKinds: readonly string[];
};

export type BugReportDescriptionValidation =
  | { ok: true; value: string }
  | { ok: false; error: string };

const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/i;
const EMAIL_PATTERN = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/i;
const OPAQUE_ID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i;
const GENERIC_NAME_TERMS = new Set([
  "anonymous",
  "guest",
  "host",
  "local",
  "player",
  "test",
  "user",
]);

function containsUnsafeControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x08 ||
      (codePoint >= 0x0b && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x061c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });
}

export function viewportBucket(width: number): BugReportViewport {
  if (width <= 480) return "narrow";
  if (width <= 720) return "mobile";
  if (width <= 1024) return "tablet";
  return "desktop";
}

export function createPrivateBugReportTerms(input: {
  names: readonly string[];
  secrets: readonly string[];
}): string[] {
  const terms = new Set(input.secrets.filter(Boolean));
  for (const rawName of input.names) {
    const name = rawName.normalize("NFKC").trim();
    if (!name) continue;
    const normalizedName = name.toLowerCase();
    if (!GENERIC_NAME_TERMS.has(normalizedName)) terms.add(name);
    for (const token of name.split(/[^\p{L}\p{N}]+/u)) {
      const normalizedToken = token.toLowerCase();
      if (
        Array.from(token).length >= 3 &&
        !GENERIC_NAME_TERMS.has(normalizedToken)
      ) {
        terms.add(token);
      }
    }
  }
  return [...terms];
}

export function createSafeBugReportLegalActions(
  input: SafeBugReportLegalActionInput,
): SafeBugReportLegalAction[] {
  const actions: SafeBugReportLegalAction[] = [];
  if (input.canSetReady) actions.push("set_ready");
  if (input.canStart) actions.push("start_game");
  if (input.canPlayCard) actions.push("play_card");
  if (input.canDrawUntilPlayable) actions.push("draw_until_playable");
  if (input.canAcceptPenalty) actions.push("accept_penalty");
  if (input.canChooseRouletteColor) actions.push("choose_roulette_color");
  if (input.canDeclareUno) actions.push("declare_uno");
  if (input.canCatchUno) actions.push("catch_uno");
  if (input.canRematch) actions.push("rematch");
  if (input.canLeave) actions.push("leave_game");
  return actions;
}

export function createSafeBugReportDiagnostics(
  input: BugReportDiagnosticInput,
): SafeBugReportDiagnostics {
  return {
    ...APP_RELEASE_IDENTITY,
    phase: input.phase,
    revision: input.revision,
    rulesVersion: RULES_VERSION,
    protocolVersion: GAME_PROTOCOL_VERSION,
    connection: input.connection,
    currentTurnIsSelf: input.currentTurnIsSelf,
    activeColor: input.activeColor,
    pendingDraw: input.pendingDraw
      ? {
          total: Math.max(0, Math.trunc(input.pendingDraw.total)),
          minimum: Math.max(0, Math.trunc(input.pendingDraw.minimum)),
        }
      : null,
    direction: input.direction,
    playerCount: Math.max(0, Math.min(6, Math.trunc(input.playerCount))),
    viewportBucket: input.viewportBucket,
    rouletteChoice: input.rouletteChoice,
    legalActions: input.legalActions.filter((action) => SAFE_BUG_REPORT_LEGAL_ACTIONS.has(action)),
    recentEventKinds: input.recentEventKinds
      .filter(
        (kind): kind is string =>
          typeof kind === "string" &&
          SAFE_BUG_REPORT_EVENT_KINDS.has(kind),
      )
      .slice(-3),
  };
}

export function validateBugReportDescription(
  rawValue: string,
  privateValues: readonly string[] = [],
): BugReportDescriptionValidation {
  const value = rawValue.normalize("NFKC").trim();
  const codePointLength = Array.from(value).length;
  if (codePointLength < BUG_REPORT_DESCRIPTION_MIN_LENGTH) {
    return {
      ok: false,
      error: `Describe what happened in at least ${BUG_REPORT_DESCRIPTION_MIN_LENGTH} characters.`,
    };
  }
  if (codePointLength > BUG_REPORT_DESCRIPTION_MAX_LENGTH) {
    return {
      ok: false,
      error: `Keep the description to ${BUG_REPORT_DESCRIPTION_MAX_LENGTH} characters or fewer.`,
    };
  }
  if (URL_PATTERN.test(value) || EMAIL_PATTERN.test(value)) {
    return {
      ok: false,
      error: "Remove links and email addresses before creating the report.",
    };
  }
  if (OPAQUE_ID_PATTERN.test(value)) {
    return {
      ok: false,
      error: "Remove game, player, and card IDs before creating the report.",
    };
  }
  if (containsUnsafeControl(value)) {
    return {
      ok: false,
      error: "Remove hidden formatting and control characters before creating the report.",
    };
  }

  const normalizedValue = value.toLowerCase();
  const includesPrivateValue = privateValues.some((privateValue) => {
    const normalizedPrivateValue = privateValue.normalize("NFKC").trim().toLowerCase();
    return normalizedPrivateValue.length >= 3 && normalizedValue.includes(normalizedPrivateValue);
  });
  if (includesPrivateValue) {
    return {
      ok: false,
      error: "Replace player names, table codes, and exact card details with general terms.",
    };
  }

  return { ok: true, value };
}

export function buildBugReportDraft(input: {
  category: BugReportCategory;
  description: string;
  diagnostics: SafeBugReportDiagnostics;
}): { title: string; body: string; text: string } {
  const category = BUG_REPORT_CATEGORIES.find((entry) => entry.id === input.category);
  if (!category) throw new Error("Unsupported game issue category.");

  const title = `[Game issue] ${category.label}`;
  const body = [
    "## What happened",
    input.description,
    "",
    "## Category",
    `${category.label} (\`${category.id}\`)`,
    "",
    "## Safe diagnostics",
    "```json",
    JSON.stringify(input.diagnostics, null, 2),
    "```",
    "",
    "## Privacy check",
    "This draft intentionally excludes account and player names, table codes, game IDs, private hands, and card IDs.",
  ].join("\n");

  return {
    title,
    body,
    text: `${title}\n\n${body}`,
  };
}

export function buildBugReportIssueUrl(input: {
  category: BugReportCategory;
  description: string;
  diagnostics: SafeBugReportDiagnostics;
}): string {
  const draft = buildBugReportDraft(input);
  const repositoryUrl = new URL(BUG_REPORT_REPOSITORY_URL);
  const expectedPath = `${repositoryUrl.pathname.replace(/\/$/, "")}/issues/new`;
  const url = new URL(expectedPath, repositoryUrl.origin);
  url.searchParams.set("title", draft.title);
  url.searchParams.set("body", draft.body);
  const queryKeys = [...url.searchParams.keys()];
  if (
    url.origin !== repositoryUrl.origin ||
    url.pathname !== expectedPath ||
    url.hash ||
    queryKeys.length !== 2 ||
    queryKeys[0] !== "title" ||
    queryKeys[1] !== "body"
  ) {
    throw new Error("BUG_REPORT_URL_INVALID");
  }
  const encodedUrl = url.toString();
  if (encodedUrl.length > BUG_REPORT_MAX_URL_LENGTH) {
    throw new Error("BUG_REPORT_URL_TOO_LONG");
  }
  return encodedUrl;
}
