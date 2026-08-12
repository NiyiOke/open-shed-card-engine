"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cardLabel, isWild } from "../../lib/game/deck";
import {
  COLORS,
  type Card,
  type CardColor,
  type GameCommand,
  type GameView,
} from "../../lib/game/types";
import type { LobbySummary } from "../../lib/server/game-store";
import { APP_RELEASE_IDENTITY } from "../../lib/app-version";
import { CardFace } from "./CardFace";
import { GameTableCanvas } from "./GameTableCanvas";
import { SignedOutLanding } from "./SignedOutLanding";
import { ReleaseIdentity, tableRevisionLabel } from "./release-ui";
import {
  canApplyRefreshedGameView,
  rankSeriesScores,
  roundLabel,
  seriesWinLabel,
  winnerReasonLabel,
} from "./continuity-ui";
import {
  createGameAudioController,
  type AudioCapabilities,
  type AudioDebugState,
  type AudioSettings,
  type GameAudioController,
  type GameAudioEvent,
} from "./game-audio";
import {
  createLiveVoiceController,
  type LiveVoiceController,
  type LiveVoiceSnapshot,
  type LiveVoiceStatus,
} from "./live-voice";
import {
  CHAT_MESSAGE_LIMIT,
  CHAT_PHRASES,
  CHAT_REACTIONS,
  CHAT_REPORT_REASONS,
  CHAT_TEXT_MAX_GRAPHEMES,
  chatContentPresentation,
  countChatGraphemes,
  parseChatPage,
  prepareChatText,
  type ChatContentId,
  type ChatMessage,
  type ChatReportReason,
  type CuratedChatKind,
} from "./chat-ui";
import {
  BUG_REPORT_CATEGORIES,
  BUG_REPORT_DESCRIPTION_MAX_LENGTH,
  buildBugReportDraft,
  buildBugReportIssueUrl,
  createPrivateBugReportTerms,
  createSafeBugReportDiagnostics,
  createSafeBugReportLegalActions,
  validateBugReportDescription,
  viewportBucket,
  type BugReportCategory,
  type SafeBugReportDiagnostics,
} from "./bug-report";
import {
  listingFailureMessage,
  listingUnavailableReason,
  isValidRoomAlias,
  normalizeRoomAlias,
  normalizePublicListingId,
  parsePublicAvailability,
  parsePublicRoomPage,
  parseViewerListing,
  PUBLIC_PACES,
  ROOM_ALIAS_ERROR,
  ROOM_ALIAS_MAX_LENGTH,
  publicJoinFailureMessage,
  type PublicPace,
  type PublicRoomCard,
  type PublicRoomPage,
  type ViewerListing,
  waitingAgeLabel,
} from "./public-discovery";

type Session = {
  signedIn: boolean;
  displayName: string;
  development: boolean;
};

type SessionResponse = {
  signedIn: boolean;
  user: { displayName: string; development: boolean } | null;
};

type Lobbies = { mine: LobbySummary[] };
type EventLine = { type: string; message: string };
type RequestFailure = Error & { code?: string };
type ConnectionState = "live" | "syncing" | "reconnecting" | "offline";
type GuideTopic = "rules" | "actions";
type AudioTransitionSnapshot = {
  canDeclareUno: boolean;
  currentPlayerId: string | null;
  gameId: string;
  handCount: number;
  pendingDrawTotal: number;
  phase: GameView["phase"];
  revision: number;
  selfPlayerId: string | null;
  selfStatus: string | null;
  topDiscardId: string | null;
  turnNumber: number;
};
type AudioFxMarker = { gameId: string; revision: number };
type PresencePlayer = {
  playerId: string;
  lastSeenAt: number;
  status: "live" | "reconnecting" | "disconnected";
  removable: boolean;
};
type PresenceSnapshot = {
  serverTime: number;
  thresholds: {
    reconnectingAfterMs: number;
    disconnectedAfterMs: number;
    removableAfterMs: number;
  };
  players: PresencePlayer[];
};
type V11GameCommand =
  | GameCommand
  | { type: "rematch" }
  | { type: "remove_inactive_player"; targetPlayerId: string };
type StoredCommand = {
  commandId: string;
  command: V11GameCommand;
  createdAt: number;
  expectedRevision: number;
  gameId: string;
};
type GameSnapshotResponse = {
  view: GameView;
  events?: EventLine[];
  eventCursor?: number;
  presence?: PresenceSnapshot;
  listing?: ViewerListing | null;
};
type PollRequest = {
  controller: AbortController;
  gameId: string;
  promise: Promise<boolean>;
};
type PublicJoinIntent =
  | { kind: "listing"; listingId: string; room: PublicRoomCard | null }
  | { kind: "quick" };
type ListingDialogAction = "publish" | "unpublish";
type PendingPublicMutation = { commandId: string; fingerprint: string };
type SidebarTab = "chat" | "activity";
type ChatModerationAction = "mute" | "block" | "report";
type ChatDialog = {
  action: ChatModerationAction;
  playerId: string;
  displayName: string;
  message: ChatMessage | null;
};
const COMMAND_STORAGE_KEY = "open-shed-inflight-command-v1";
const CHAT_TAB_STORAGE_KEY = "open-shed-chat-tab-v1";
const CHAT_ANNOUNCEMENTS_STORAGE_KEY = "open-shed-chat-announcements-v1";
const REQUEST_TIMEOUT_MS = 12_000;
const LIVE_VOICE_STATUS_COPY: Record<LiveVoiceStatus, string> = {
  unavailable: "Voice setup required",
  available: "Private voice eligible",
  prejoin: "Review before joining",
  requesting_permission: "Waiting for microphone permission",
  permission_denied: "Microphone permission denied",
  joining: "Joining voice muted",
  joined_muted: "In voice · microphone off",
  joined_live: "In voice · microphone on",
  reconnecting: "Voice reconnecting",
  listen_only: "Listening · microphone unavailable",
  failed: "Voice could not connect",
  ended: "Voice session ended",
};
const INITIAL_LIVE_VOICE_SNAPSHOT: LiveVoiceSnapshot = Object.freeze({
  status: "unavailable",
  microphoneEnabled: false,
  outputMuted: false,
  audioPlaybackBlocked: false,
  participants: Object.freeze([]),
  error: null,
});

const ACTION_GUIDE = [
  ["Draw 2 / Draw 4", "The next player stacks an equal-or-higher draw card or takes the full penalty."],
  ["Skip / Reverse", "Skip the next active player or reverse direction. With two players, Reverse skips the other player."],
  ["Discard All", "Discard every other card in your hand that shares this card's color."],
  ["Skip Everyone", "Skip every other active player and immediately play again."],
  ["Wild Reverse +4", "Choose a color, reverse direction, and send a four-card penalty in the new direction."],
  ["Wild +6 / +10", "Choose the continuing color and send the printed draw penalty to the next active player."],
  ["Color Roulette", "The target chooses a color, then reveals cards until that color appears and takes the full revealed batch."],
] as const;

declare global {
  interface Window {
    render_game_to_text?: () => string;
    advanceTime?: (milliseconds: number) => number;
  }
}

export function GameShell({
  initialSession,
  signInPath,
}: {
  initialSession: Session | null;
  signInPath: string;
}) {
  const [session, setSession] = useState<Session | null>(initialSession);
  const [lobbies, setLobbies] = useState<Lobbies>({ mine: [] });
  const [game, setGame] = useState<GameView | null>(null);
  const [nickname, setNickname] = useState(initialSession?.displayName ?? "");
  const [joinAlias, setJoinAlias] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<EventLine[]>([]);
  const [pendingCard, setPendingCard] = useState<Card | null>(null);
  const [chosenColor, setChosenColor] = useState<CardColor | null>(null);
  const [swapTargetId, setSwapTargetId] = useState<string | null>(null);
  const [declareWithPlay, setDeclareWithPlay] = useState(false);
  const [testPlayerDialogOpen, setTestPlayerDialogOpen] = useState(false);
  const [testPlayerName, setTestPlayerName] = useState("");
  const [testPlayerNameError, setTestPlayerNameError] = useState<string | null>(null);
  const [switchingTestPlayer, setSwitchingTestPlayer] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>("live");
  const [presence, setPresence] = useState<PresenceSnapshot | null>(null);
  const [resolvedSignInPath, setResolvedSignInPath] = useState(signInPath);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [shareFeedback, setShareFeedback] = useState<string | null>(null);
  const [guideTopic, setGuideTopic] = useState<GuideTopic | null>(null);
  const [soundDialogOpen, setSoundDialogOpen] = useState(false);
  const [soundSettings, setSoundSettings] = useState<AudioSettings>({
    enabled: false,
    spokenCallouts: true,
    volume: 65,
  });
  const [soundDebug, setSoundDebug] = useState<AudioDebugState>({
    enabled: false,
    lastCallout: null,
    lastCue: null,
    lastRevision: null,
    speechSupported: false,
    supported: false,
    unlocked: false,
  });
  const [soundCapabilities, setSoundCapabilities] = useState<AudioCapabilities>({
    effects: false,
    speech: false,
  });
  const [soundStatus, setSoundStatus] = useState<string | null>(null);
  const [playedCardFxRevision, setPlayedCardFxRevision] = useState<AudioFxMarker | null>(null);
  const [turnFxRevision, setTurnFxRevision] = useState<AudioFxMarker | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [bugReportOpen, setBugReportOpen] = useState(false);
  const [bugReportCategory, setBugReportCategory] =
    useState<BugReportCategory>("turn_stuck");
  const [bugReportDescription, setBugReportDescription] = useState("");
  const [bugReportDiagnostics, setBugReportDiagnostics] =
    useState<SafeBugReportDiagnostics | null>(null);
  const [bugReportPrivateCanaries, setBugReportPrivateCanaries] = useState<string[]>([]);
  const [bugReportError, setBugReportError] = useState<string | null>(null);
  const [bugReportStatus, setBugReportStatus] = useState<string | null>(null);
  const [removeTargetId, setRemoveTargetId] = useState<string | null>(null);
  const [hostClaimPending, setHostClaimPending] = useState(false);
  const [storedCommand, setStoredCommand] = useState<StoredCommand | null>(null);
  const [sidebarDetailsOpen, setSidebarDetailsOpen] = useState(false);
  const [publicRooms, setPublicRooms] = useState<PublicRoomPage | null>(null);
  const [publicDiscoveryEnabled, setPublicDiscoveryEnabled] = useState(false);
  const [linkedListingIntent, setLinkedListingIntent] = useState<string | null>(null);
  const [publicJoinIntent, setPublicJoinIntent] = useState<PublicJoinIntent | null>(null);
  const [publicAlias, setPublicAlias] = useState("");
  const [publicJoinError, setPublicJoinError] = useState<string | null>(null);
  const [listing, setListing] = useState<ViewerListing | null>(null);
  const [listingDialogAction, setListingDialogAction] = useState<ListingDialogAction | null>(null);
  const [listingAlias, setListingAlias] = useState("");
  const [listingPace, setListingPace] = useState<PublicPace>("casual");
  const [listingError, setListingError] = useState<string | null>(null);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("activity");
  const [chatEnabled, setChatEnabled] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatUnread, setChatUnread] = useState(0);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatStatus, setChatStatus] = useState<string | null>(null);
  const [chatSending, setChatSending] = useState(false);
  const [chatCoolingDown, setChatCoolingDown] = useState(false);
  const [chatAnnouncements, setChatAnnouncements] = useState(true);
  const [chatFreeTextEnabled, setChatFreeTextEnabled] = useState(false);
  const [chatLiveVoiceEnabled, setChatLiveVoiceEnabled] = useState(false);
  const [chatDraft, setChatDraft] = useState("");
  const [chatDraftError, setChatDraftError] = useState<string | null>(null);
  const [mutedChatPlayers, setMutedChatPlayers] = useState<Record<string, string>>({});
  const [blockedChatPlayers, setBlockedChatPlayers] = useState<Record<string, string>>({});
  const [chatDialog, setChatDialog] = useState<ChatDialog | null>(null);
  const [chatReportReason, setChatReportReason] = useState<ChatReportReason>("harassment");
  const [chatModerationBusy, setChatModerationBusy] = useState(false);
  const [chatViewportMobile, setChatViewportMobile] = useState(false);
  const [documentVisible, setDocumentVisible] = useState(true);
  const [chatRefreshTick, setChatRefreshTick] = useState(0);
  const [voiceSheetOpen, setVoiceSheetOpen] = useState(false);
  const [liveVoiceSnapshot, setLiveVoiceSnapshot] = useState<LiveVoiceSnapshot>(
    INITIAL_LIVE_VOICE_SNAPSHOT,
  );
  const gameRef = useRef<GameView | null>(null);
  const eventCursorRef = useRef<{ gameId: string; revision: number } | null>(null);
  const pollRequestRef = useRef<PollRequest | null>(null);
  const pollFailureCountRef = useRef(0);
  const deepLinkInFlight = useRef<string | null>(null);
  const choiceDialogRef = useRef<HTMLDivElement>(null);
  const choiceTriggerRef = useRef<HTMLButtonElement | null>(null);
  const testPlayerDialogRef = useRef<HTMLDivElement>(null);
  const testPlayerInputRef = useRef<HTMLInputElement>(null);
  const testPlayerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const testPlayerSwitchingRef = useRef(false);
  const utilityDialogRef = useRef<HTMLDivElement>(null);
  const utilityTriggerRef = useRef<HTMLButtonElement | null>(null);
  const soundDialogRef = useRef<HTMLDivElement>(null);
  const soundTriggerRef = useRef<HTMLButtonElement | null>(null);
  const audioControllerRef = useRef<GameAudioController | null>(null);
  const audioTransitionRef = useRef<AudioTransitionSnapshot | null>(null);
  const audioInterruptedRef = useRef(false);
  const bugReportDialogRef = useRef<HTMLDivElement>(null);
  const bugReportDescriptionRef = useRef<HTMLTextAreaElement>(null);
  const bugReportTriggerRef = useRef<HTMLButtonElement | null>(null);
  const publicAliasInputRef = useRef<HTMLInputElement>(null);
  const storedRetryKeyRef = useRef<string | null>(null);
  const presenceAvailableRef = useRef(true);
  const publicJoinMutationRef = useRef<PendingPublicMutation | null>(null);
  const listingMutationRef = useRef<PendingPublicMutation | null>(null);
  const chatCursorRef = useRef<{ gameId: string; cursor: string | null } | null>(null);
  const chatMessageIdsRef = useRef(new Set<string>());
  const chatSendMutationRef = useRef<PendingPublicMutation | null>(null);
  const chatReportMutationRef = useRef<PendingPublicMutation | null>(null);
  const chatTabPreferenceRef = useRef(false);
  const chatDialogRef = useRef<HTMLDivElement>(null);
  const chatDialogTriggerRef = useRef<HTMLButtonElement | null>(null);
  const chatLogRef = useRef<HTMLDivElement>(null);
  const voiceSheetRef = useRef<HTMLDivElement>(null);
  const voiceSheetTriggerRef = useRef<HTMLButtonElement | null>(null);
  const liveVoiceControllerRef = useRef<LiveVoiceController | null>(null);
  const testClock = useRef(0);
  const [reconnectTick, setReconnectTick] = useState(0);

  const syncSoundState = useCallback(() => {
    const controller = audioControllerRef.current;
    if (!controller) return;
    setSoundSettings(controller.getSettings());
    setSoundDebug(controller.getDebugState());
    setSoundCapabilities(controller.getCapabilities());
  }, []);

  const request = useCallback(async <T,>(path: string, options?: RequestInit) => {
    const headers = new Headers(options?.headers);
    const localIdentity = getLocalIdentity();
    if (localIdentity) {
      headers.set("X-Open-Shed-Dev-User", localIdentity.id);
      headers.set("X-Open-Shed-Dev-Name", localIdentity.name);
    }

    const controller = new AbortController();
    let timedOut = false;
    const sourceSignal = options?.signal;
    const abortFromSource = () => controller.abort(sourceSignal?.reason);
    if (sourceSignal?.aborted) abortFromSource();
    else sourceSignal?.addEventListener("abort", abortFromSource, { once: true });
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(path, {
        ...options,
        headers,
        cache: "no-store",
        signal: controller.signal,
      });
      const body = (await response.json()) as T & {
        error?: { code: string; message: string };
      };
      if (!response.ok) {
        const failure = new Error(body.error?.message ?? "Request failed.") as RequestFailure;
        failure.code = body.error?.code;
        throw failure;
      }
      return body;
    } catch (failure) {
      if (timedOut) {
        const timeoutFailure = new Error(
          "The table took too long to respond. Your action is safe to retry.",
        ) as RequestFailure;
        timeoutFailure.code = "REQUEST_TIMEOUT";
        throw timeoutFailure;
      }
      throw failure;
    } finally {
      window.clearTimeout(timeout);
      sourceSignal?.removeEventListener("abort", abortFromSource);
    }
  }, []);

  useEffect(() => {
    const controller = createGameAudioController();
    audioControllerRef.current = controller;
    const frame = window.requestAnimationFrame(() => {
      if (audioControllerRef.current !== controller) return;
      setSoundSettings(controller.getSettings());
      setSoundDebug(controller.getDebugState());
      setSoundCapabilities(controller.getCapabilities());
    });
    const stopForegroundAudioWhenHidden = () => {
      if (document.hidden) controller.cancel();
    };
    document.addEventListener("visibilitychange", stopForegroundAudioWhenHidden);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", stopForegroundAudioWhenHidden);
      if (audioControllerRef.current === controller) audioControllerRef.current = null;
      void controller.dispose();
    };
  }, []);

  const loadLobbies = useCallback(async () => {
    try {
      setLobbies(await request<Lobbies>("/api/games"));
    } catch {
      // Lobby discovery is secondary to an active table and retries on focus.
    }
  }, [request]);

  const loadPublicRooms = useCallback(async () => {
    try {
      const availabilityResponse = await request<unknown>("/api/public/availability");
      if (!parsePublicAvailability(availabilityResponse)) {
        setPublicDiscoveryEnabled(false);
        setPublicRooms(null);
        return;
      }
      setPublicDiscoveryEnabled(true);
      try {
        const response = await request<unknown>("/api/public/rooms");
        const page = parsePublicRoomPage(response, 20);
        if (!page && (response as { enabled?: unknown })?.enabled === false) {
          setPublicDiscoveryEnabled(false);
        }
        setPublicRooms(page);
      } catch {
        setPublicRooms(null);
      }
    } catch {
      // Public discovery is optional and fail-closed.
      setPublicDiscoveryEnabled(false);
      setPublicRooms(null);
    }
  }, [request]);

  useEffect(() => {
    let cancelled = false;
    void request<SessionResponse>("/api/session")
      .then((response) => {
        if (cancelled) return;
        const next = response.user
          ? {
              signedIn: true,
              displayName: response.user.displayName,
              development: response.user.development,
            }
          : { signedIn: false, displayName: "", development: false };
        setSession(next);
        setNickname((current) => current || next.displayName);
        if (next.signedIn) {
          void loadLobbies();
          void loadPublicRooms();
        }
      })
      .catch(() => {
        if (!cancelled) setSession({ signedIn: false, displayName: "", development: false });
      });
    return () => {
      cancelled = true;
    };
  }, [loadLobbies, loadPublicRooms, request]);

  useEffect(() => {
    const code = normalizeJoinCodeFromUrl(window.location.search);
    const urlParams = new URLSearchParams(window.location.search);
    const hasLinkedGame = urlParams.has("game");
    const listingId = normalizePublicListingId(urlParams.get("listing"));
    const frame = window.requestAnimationFrame(() => {
      if (code) {
        const authUrl = new URL(signInPath, window.location.origin);
        authUrl.searchParams.set("return_to", `/?join=${encodeURIComponent(code)}`);
        setResolvedSignInPath(`${authUrl.pathname}${authUrl.search}`);
        setJoinCode(code);
        setJoinAlias("");
        setInviteCode(code);
        setInviteDialogOpen(!hasLinkedGame);
      } else if (listingId) {
        const authUrl = new URL(signInPath, window.location.origin);
        authUrl.searchParams.set("return_to", `/?listing=${encodeURIComponent(listingId)}`);
        setResolvedSignInPath(`${authUrl.pathname}${authUrl.search}`);
        if (!hasLinkedGame) setLinkedListingIntent(listingId);
      } else {
        setResolvedSignInPath(signInPath);
      }
      setStoredCommand(readStoredCommand());
    });
    return () => window.cancelAnimationFrame(frame);
  }, [signInPath]);

  useEffect(() => {
    if (
      !session?.signedIn ||
      game ||
      !publicDiscoveryEnabled ||
      !linkedListingIntent ||
      publicJoinIntent
    ) {
      return;
    }
    const room = publicRooms?.rooms.find(
      (candidate) => candidate.listingId === linkedListingIntent,
    ) ?? null;
    const frame = window.requestAnimationFrame(() => {
      publicJoinMutationRef.current = null;
      setPublicAlias("");
      setPublicJoinError(null);
      setPublicJoinIntent({ kind: "listing", listingId: linkedListingIntent, room });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    game,
    linkedListingIntent,
    publicDiscoveryEnabled,
    publicJoinIntent,
    publicRooms,
    session?.signedIn,
  ]);

  useEffect(() => {
    const markOffline = () => setConnectionState("offline");
    const markOnline = () => {
      setConnectionState("reconnecting");
      storedRetryKeyRef.current = null;
      setReconnectTick((current) => current + 1);
    };
    const frame = window.requestAnimationFrame(() => {
      setConnectionState(navigator.onLine ? "live" : "offline");
    });
    window.addEventListener("offline", markOffline);
    window.addEventListener("online", markOnline);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("offline", markOffline);
      window.removeEventListener("online", markOnline);
    };
  }, []);

  const refreshGame = useCallback((requestedGameId?: string): Promise<boolean> => {
    const gameId = requestedGameId ?? gameRef.current?.gameId;
    if (!gameId) return Promise.resolve(false);

    const existing = pollRequestRef.current;
    if (existing?.gameId === gameId) return existing.promise;
    existing?.controller.abort();

    const controller = new AbortController();
    const promise = (async () => {
      try {
        const cursor =
          eventCursorRef.current?.gameId === gameId
            ? eventCursorRef.current.revision
            : Math.max(0, gameRef.current?.revision ?? 0);
        const response = await request<GameSnapshotResponse>(
          `/api/games/${encodeURIComponent(gameId)}?afterRevision=${cursor}`,
          { signal: controller.signal },
        );
        pollFailureCountRef.current = 0;
        setConnectionState("live");
        if (response.presence) setPresence(response.presence);
        if (Object.prototype.hasOwnProperty.call(response, "listing")) {
          setListing(parseViewerListing(response.listing));
        }
        if (gameRef.current?.gameId !== gameId) return false;
        const latestCursor = eventCursorRef.current;
        if (
          latestCursor?.gameId === gameId &&
          latestCursor.revision <= cursor
        ) {
          if (typeof response.eventCursor === "number") {
            eventCursorRef.current = {
              gameId,
              revision: Math.max(cursor, response.eventCursor),
            };
          }
          if (response.events?.length) {
            setEvents((currentEvents) =>
              [...currentEvents, ...response.events!].slice(-12),
            );
          }
        }
        const current = gameRef.current;
        if (!canApplyRefreshedGameView(current, response.view, gameId)) {
          return false;
        }
        gameRef.current = response.view;
        setGame(response.view);
        return true;
      } catch (failure) {
        if ((failure as Error).name === "AbortError") return false;
        pollFailureCountRef.current = Math.min(pollFailureCountRef.current + 1, 5);
        setConnectionState(navigator.onLine ? "reconnecting" : "offline");
        const code = (failure as RequestFailure).code;
        if (
          gameRef.current?.gameId === gameId &&
          ["AUTHENTICATION_REQUIRED", "GAME_EXPIRED", "GAME_NOT_FOUND", "ROOM_CLOSED", "NOT_A_MEMBER"].includes(
            code ?? "",
          )
        ) {
          setError(failure instanceof Error ? failure.message : "The table is unavailable.");
        }
        return false;
      } finally {
        if (pollRequestRef.current?.controller === controller) {
          pollRequestRef.current = null;
        }
      }
    })();

    pollRequestRef.current = { controller, gameId, promise };
    return promise;
  }, [request]);

  const activeGameId = game?.gameId ?? null;
  const activeGamePhase = game?.phase ?? null;
  const chatHasAnotherPlayer = Boolean(
    game?.players.some((player) => !player.isSelf && player.status !== "left"),
  );
  const visibleChatMessages = useMemo(() => {
    if (!game) return [];
    const currentPlayerIds = new Set(
      game.players
        .filter((player) => player.status !== "left")
        .map((player) => player.playerId),
    );
    return chatMessages.filter(
      (message) =>
        currentPlayerIds.has(message.senderPlayerId) &&
        !mutedChatPlayers[message.senderPlayerId] &&
        !blockedChatPlayers[message.senderPlayerId],
    );
  }, [blockedChatPlayers, chatMessages, game, mutedChatPlayers]);
  const chatDraftGraphemes = useMemo(
    () => countChatGraphemes(chatDraft),
    [chatDraft],
  );
  const preparedChatDraft = useMemo(() => prepareChatText(chatDraft), [chatDraft]);
  const chatPanelVisible = Boolean(
    chatEnabled &&
    sidebarTab === "chat" &&
    documentVisible &&
    (!chatViewportMobile || sidebarDetailsOpen),
  );

  useEffect(() => {
    let active = true;
    if (!activeGameId) {
      liveVoiceControllerRef.current = null;
      const resetFrame = window.requestAnimationFrame(() => {
        setLiveVoiceSnapshot(INITIAL_LIVE_VOICE_SNAPSHOT);
      });
      return () => window.cancelAnimationFrame(resetFrame);
    }
    const voiceFetcher: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      const localIdentity = getLocalIdentity();
      if (localIdentity) {
        headers.set("X-Open-Shed-Dev-User", localIdentity.id);
        headers.set("X-Open-Shed-Dev-Name", localIdentity.name);
      }
      return fetch(input, { ...init, headers, cache: "no-store" });
    };
    const controller = createLiveVoiceController({
      gameId: activeGameId,
      fetcher: voiceFetcher,
      onChange: (snapshot) => {
        if (active) setLiveVoiceSnapshot(snapshot);
      },
    });
    liveVoiceControllerRef.current = controller;
    if (chatLiveVoiceEnabled) controller.markAvailable();
    const snapshotFrame = window.requestAnimationFrame(() => {
      if (active) setLiveVoiceSnapshot(controller.getSnapshot());
    });
    return () => {
      active = false;
      window.cancelAnimationFrame(snapshotFrame);
      if (liveVoiceControllerRef.current === controller) {
        liveVoiceControllerRef.current = null;
      }
      void controller.dispose();
    };
  }, [activeGameId, chatLiveVoiceEnabled]);

  useEffect(() => {
    gameRef.current = game;
  }, [game]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", update);
      return () => query.removeEventListener("change", update);
    }
    query.addListener(update);
    return () => query.removeListener(update);
  }, []);

  useEffect(() => {
    if (connectionState === "reconnecting" || connectionState === "offline") {
      audioInterruptedRef.current = true;
    }
  }, [connectionState]);

  useEffect(() => {
    if (!game) {
      audioTransitionRef.current = null;
      audioInterruptedRef.current = false;
      audioControllerRef.current?.resetTransitionHistory();
      const frame = window.requestAnimationFrame(() => {
        setPlayedCardFxRevision(null);
        setTurnFxRevision(null);
        syncSoundState();
      });
      return () => window.cancelAnimationFrame(frame);
    }

    const selfPlayer = game.players.find((player) => player.isSelf) ?? null;
    const current: AudioTransitionSnapshot = {
      canDeclareUno: game.legalActions.canDeclareUno,
      currentPlayerId: game.currentPlayerId,
      gameId: game.gameId,
      handCount: game.hand.length,
      pendingDrawTotal: game.pendingDraw?.total ?? 0,
      phase: game.phase,
      revision: game.revision,
      selfPlayerId: selfPlayer?.playerId ?? null,
      selfStatus: selfPlayer?.status ?? null,
      topDiscardId: game.topDiscard?.id ?? null,
      turnNumber: game.turnNumber,
    };
    const previous = audioTransitionRef.current;

    // Entering or re-opening a table hydrates the baseline without replaying old cues.
    if (
      !previous ||
      previous.gameId !== current.gameId ||
      current.revision <= previous.revision
    ) {
      if (!previous || previous.gameId !== current.gameId) {
        audioControllerRef.current?.resetTransitionHistory();
        audioTransitionRef.current = current;
        audioInterruptedRef.current = false;
        const frame = window.requestAnimationFrame(() => {
          setPlayedCardFxRevision(null);
          setTurnFxRevision(null);
          syncSoundState();
        });
        return () => window.cancelAnimationFrame(frame);
      }
      return;
    }

    audioTransitionRef.current = current;
    const revisionDelta = current.revision - previous.revision;
    if (audioInterruptedRef.current || revisionDelta > 1) {
      audioInterruptedRef.current = false;
      return;
    }
    const canPresentLiveTransition =
      connectionState === "live" || connectionState === "syncing";
    if (!canPresentLiveTransition) return;

    const becameSelfTurn = Boolean(
      current.phase === "playing" &&
        current.selfPlayerId &&
        current.currentPlayerId === current.selfPlayerId &&
        (previous.currentPlayerId !== current.selfPlayerId ||
          current.turnNumber > previous.turnNumber),
    );
    const playedCardChanged = Boolean(
      previous.phase === "playing" &&
        current.phase === "playing" &&
        current.topDiscardId &&
        current.topDiscardId !== previous.topDiscardId,
    );

    const fxFrame = !document.hidden && (playedCardChanged || becameSelfTurn)
      ? window.requestAnimationFrame(() => {
          if (playedCardChanged) {
            setPlayedCardFxRevision({ gameId: current.gameId, revision: current.revision });
          }
          if (becameSelfTurn) {
            setTurnFxRevision({ gameId: current.gameId, revision: current.revision });
          }
        })
      : null;

    const controller = audioControllerRef.current;
    if (!controller) {
      return () => {
        if (fxFrame !== null) window.cancelAnimationFrame(fxFrame);
      };
    }
    const visible = !document.hidden;
    const eventBase = {
      revision: current.revision,
      visible,
      connected: true,
      hydrating: false,
    } as const;
    let audioEvent: GameAudioEvent | null = null;
    if (previous.phase !== "complete" && current.phase === "complete") {
      audioEvent = {
        ...eventBase,
        kind: "win",
        dedupeId: `win:${current.revision}`,
      };
    } else if (previous.phase === "lobby" && current.phase === "playing") {
      audioEvent = {
        ...eventBase,
        kind: "game_start",
        dedupeId: `game_start:${current.revision}`,
      };
    } else if (playedCardChanged && game.topDiscard) {
      audioEvent = {
        ...eventBase,
        kind: "card_played",
        card: game.topDiscard,
        activeColor: game.activeColor,
        dedupeId: `card_played:${current.revision}`,
      };
    } else if (current.handCount > previous.handCount) {
      audioEvent = {
        ...eventBase,
        kind: "draw",
        dedupeId: `draw:${current.revision}`,
      };
    } else if (current.pendingDrawTotal > previous.pendingDrawTotal) {
      audioEvent = {
        ...eventBase,
        kind: "penalty",
        amount: current.pendingDrawTotal,
        dedupeId: `penalty:${current.revision}`,
      };
    } else if (!previous.canDeclareUno && current.canDeclareUno) {
      audioEvent = {
        ...eventBase,
        kind: "uno",
        dedupeId: `uno:${current.revision}`,
      };
    } else if (
      previous.selfStatus !== "eliminated" &&
      current.selfStatus === "eliminated"
    ) {
      audioEvent = {
        ...eventBase,
        kind: "mercy",
        dedupeId: `mercy:${current.revision}`,
      };
    }
    if (audioEvent) controller.notifyEvent(audioEvent);
    if (becameSelfTurn) {
      controller.notifyTurn({
        revision: current.revision,
        isSelfTurn: true,
        phase: current.phase,
        visible,
        connected: true,
        hydrating: false,
      });
    }
    const soundFrame = window.requestAnimationFrame(syncSoundState);
    return () => {
      if (fxFrame !== null) window.cancelAnimationFrame(fxFrame);
      window.cancelAnimationFrame(soundFrame);
    };
  }, [connectionState, game, syncSoundState]);

  useEffect(() => {
    if (playedCardFxRevision === null) return;
    const timeout = window.setTimeout(() => setPlayedCardFxRevision(null), 760);
    return () => window.clearTimeout(timeout);
  }, [playedCardFxRevision]);

  useEffect(() => {
    if (turnFxRevision === null) return;
    const timeout = window.setTimeout(() => setTurnFxRevision(null), 900);
    return () => window.clearTimeout(timeout);
  }, [turnFxRevision]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 720px)");
    const updateViewport = () => setChatViewportMobile(query.matches);
    const updateVisibility = () => setDocumentVisible(!document.hidden);
    updateViewport();
    updateVisibility();
    query.addEventListener("change", updateViewport);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      query.removeEventListener("change", updateViewport);
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, []);

  useEffect(() => {
    chatCursorRef.current = activeGameId ? { gameId: activeGameId, cursor: null } : null;
    chatMessageIdsRef.current = new Set();
    chatTabPreferenceRef.current = false;
    chatSendMutationRef.current = null;
    chatReportMutationRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      setChatEnabled(false);
      setChatMessages([]);
      setChatUnread(0);
      setChatError(null);
      setChatStatus(null);
      setChatSending(false);
      setChatCoolingDown(false);
      setChatFreeTextEnabled(false);
      setChatLiveVoiceEnabled(false);
      setChatDraft("");
      setChatDraftError(null);
      setMutedChatPlayers({});
      setBlockedChatPlayers({});
      setChatDialog(null);
      setChatModerationBusy(false);
      setVoiceSheetOpen(false);
      if (!activeGameId) return;

      const rememberedTab = window.sessionStorage.getItem(CHAT_TAB_STORAGE_KEY);
      if (rememberedTab === "chat" || rememberedTab === "activity") {
        chatTabPreferenceRef.current = true;
        setSidebarTab(rememberedTab);
      } else {
        setSidebarTab(
          gameRef.current?.players.some(
            (player) => !player.isSelf && player.status !== "left",
          )
            ? "chat"
            : "activity",
        );
      }
      setChatAnnouncements(
        window.sessionStorage.getItem(CHAT_ANNOUNCEMENTS_STORAGE_KEY) !== "off",
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeGameId]);

  useEffect(() => {
    if (
      activeGameId &&
      chatEnabled &&
      chatHasAnotherPlayer &&
      !chatTabPreferenceRef.current
    ) {
      setSidebarTab("chat");
    }
  }, [activeGameId, chatEnabled, chatHasAnotherPlayer]);

  useEffect(() => {
    if (!activeGameId) return;
    let cancelled = false;
    let timeout: number | null = null;
    let controller: AbortController | null = null;

    const schedule = () => {
      if (cancelled) return;
      if (timeout !== null) window.clearTimeout(timeout);
      timeout = window.setTimeout(
        poll,
        documentVisible && navigator.onLine ? 2_500 : 12_000,
      );
    };
    const hideDisabledChat = () => {
      setChatEnabled(false);
      setChatFreeTextEnabled(false);
      setChatLiveVoiceEnabled(false);
      setChatMessages([]);
      setChatUnread(0);
      setChatError(null);
      setChatDraft("");
      setChatDraftError(null);
      chatMessageIdsRef.current = new Set();
    };
    const poll = () => {
      if (cancelled) return;
      controller?.abort();
      controller = new AbortController();
      const cursorState = chatCursorRef.current;
      const cursor = cursorState?.gameId === activeGameId ? cursorState.cursor : null;
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      const suffix = params.size ? `?${params.toString()}` : "";
      void request<unknown>(
        `/api/games/${encodeURIComponent(activeGameId)}/messages${suffix}`,
        { signal: controller.signal },
      )
        .then((response) => {
          if (cancelled || gameRef.current?.gameId !== activeGameId) return;
          const page = parseChatPage(response);
          if (!page) {
            hideDisabledChat();
            return;
          }

          const currentGame = gameRef.current;
          const currentPlayers = new Map(
            currentGame.players
              .filter((player) => player.status !== "left")
              .map((player) => [player.playerId, player]),
          );
          const nextMutedPlayers = Object.fromEntries(
            page.viewer.mutedPlayerIds
              .map((playerId) => {
                const player = currentPlayers.get(playerId);
                return player ? [playerId, player.displayName] : null;
              })
              .filter((entry): entry is [string, string] => entry !== null),
          );
          const nextBlockedPlayers = Object.fromEntries(
            page.viewer.blockedPlayerIds
              .map((playerId) => {
                const player = currentPlayers.get(playerId);
                return player ? [playerId, player.displayName] : null;
              })
              .filter((entry): entry is [string, string] => entry !== null),
          );
          setMutedChatPlayers((current) =>
            samePlayerMap(current, nextMutedPlayers) ? current : nextMutedPlayers,
          );
          setBlockedChatPlayers((current) =>
            samePlayerMap(current, nextBlockedPlayers) ? current : nextBlockedPlayers,
          );
          const mutedIds = new Set(page.viewer.mutedPlayerIds);
          const blockedIds = new Set(page.viewer.blockedPlayerIds);
          const unseenMessages = page.messages
            .filter((message) => currentPlayers.has(message.senderPlayerId))
            .map((message) => ({
              ...message,
              senderDisplayName:
                currentPlayers.get(message.senderPlayerId)?.displayName ??
                message.senderDisplayName,
            }))
            .filter((message) => !chatMessageIdsRef.current.has(message.id));

          if (unseenMessages.length) {
            const selfId = currentGame.players.find((player) => player.isSelf)?.playerId;
            const unreadAdded = unseenMessages.filter(
              (message) =>
                message.senderPlayerId !== selfId &&
                !mutedIds.has(message.senderPlayerId) &&
                !blockedIds.has(message.senderPlayerId),
            ).length;
            setChatMessages((current) => {
              const next = [...current, ...unseenMessages].slice(-CHAT_MESSAGE_LIMIT);
              chatMessageIdsRef.current = new Set(next.map((message) => message.id));
              return next;
            });
            if (!chatPanelVisible && unreadAdded) {
              setChatUnread((current) => Math.min(99, current + unreadAdded));
            }
          }
          if (page.nextCursor !== null) {
            chatCursorRef.current = { gameId: activeGameId, cursor: page.nextCursor };
          }
          setChatEnabled(true);
          setChatFreeTextEnabled(page.viewer.capabilities.freeText);
          setChatLiveVoiceEnabled(page.viewer.capabilities.liveVoice);
          if (!page.viewer.capabilities.freeText) {
            setChatDraft("");
            setChatDraftError(null);
          }
          setChatError(null);
        })
        .catch((failure) => {
          if (cancelled || (failure as Error).name === "AbortError") return;
          const code = (failure as RequestFailure).code;
          if (
            [
              "COMMUNICATION_DISABLED",
              "FEATURE_DISABLED",
              "ROUTE_NOT_FOUND",
              "NOT_FOUND",
            ].includes(code ?? "")
          ) {
            hideDisabledChat();
          } else if (chatEnabled) {
            setChatError("Chat is reconnecting. Your game actions still work.");
          }
        })
        .finally(schedule);
    };
    const refreshNow = () => {
      if (timeout !== null) window.clearTimeout(timeout);
      poll();
    };

    poll();
    window.addEventListener("focus", refreshNow);
    window.addEventListener("online", refreshNow);
    return () => {
      cancelled = true;
      if (timeout !== null) window.clearTimeout(timeout);
      controller?.abort();
      window.removeEventListener("focus", refreshNow);
      window.removeEventListener("online", refreshNow);
    };
  }, [
    activeGameId,
    blockedChatPlayers,
    chatEnabled,
    chatPanelVisible,
    chatRefreshTick,
    documentVisible,
    mutedChatPlayers,
    request,
  ]);

  useEffect(() => {
    if (!chatPanelVisible) return;
    const frame = window.requestAnimationFrame(() => {
      setChatUnread(0);
      const log = chatLogRef.current;
      if (log) log.scrollTop = log.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [chatPanelVisible, visibleChatMessages.length]);

  useEffect(() => {
    if (!activeGameId) return;
    let cancelled = false;
    let timeout: number | null = null;

    const schedule = () => {
      if (cancelled) return;
      if (timeout !== null) window.clearTimeout(timeout);
      const visibleDelay = activeGamePhase === "complete"
        ? 5_000
        : Math.min(15_000, 1_500 * 2 ** pollFailureCountRef.current);
      timeout = window.setTimeout(() => {
        void refreshGame(activeGameId).finally(schedule);
      }, document.hidden ? Math.max(10_000, visibleDelay) : visibleDelay);
    };
    const refreshNow = () => {
      if (timeout !== null) window.clearTimeout(timeout);
      void refreshGame(activeGameId).finally(schedule);
    };
    const onVisibilityChange = () => {
      if (document.hidden) schedule();
      else refreshNow();
    };

    schedule();
    window.addEventListener("focus", refreshNow);
    window.addEventListener("online", refreshNow);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      if (timeout !== null) window.clearTimeout(timeout);
      window.removeEventListener("focus", refreshNow);
      window.removeEventListener("online", refreshNow);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [activeGameId, activeGamePhase, refreshGame]);

  useEffect(() => {
    if (!activeGameId) return;
    let cancelled = false;
    let timeout: number | null = null;

    const schedule = () => {
      if (cancelled || !presenceAvailableRef.current) return;
      if (timeout !== null) window.clearTimeout(timeout);
      timeout = window.setTimeout(
        beat,
        document.hidden ? 30_000 : activeGamePhase === "complete" ? 20_000 : 10_000,
      );
    };
    const beat = () => {
      if (cancelled || !presenceAvailableRef.current || !navigator.onLine) {
        schedule();
        return;
      }
      void request<PresenceSnapshot>(
        `/api/games/${encodeURIComponent(activeGameId)}/presence`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      )
        .then((snapshot) => {
          if (!cancelled) setPresence(snapshot);
        })
        .catch((failure) => {
          const code = (failure as RequestFailure).code;
          if (["NOT_FOUND", "ROUTE_NOT_FOUND"].includes(code ?? "")) {
            presenceAvailableRef.current = false;
          }
        })
        .finally(schedule);
    };
    const beatWhenVisible = () => {
      if (!document.hidden) beat();
    };

    beat();
    document.addEventListener("visibilitychange", beatWhenVisible);
    return () => {
      cancelled = true;
      if (timeout !== null) window.clearTimeout(timeout);
      document.removeEventListener("visibilitychange", beatWhenVisible);
    };
  }, [activeGameId, activeGamePhase, request]);

  useEffect(() => {
    const retryReconnect = () => {
      setReconnectTick((current) => current + 1);
      if (!gameRef.current) {
        void loadLobbies();
        void loadPublicRooms();
      }
    };
    window.addEventListener("focus", retryReconnect);
    window.addEventListener("online", retryReconnect);
    return () => {
      window.removeEventListener("focus", retryReconnect);
      window.removeEventListener("online", retryReconnect);
    };
  }, [loadLobbies, loadPublicRooms]);

  useEffect(() => {
    if (!shareFeedback) return;
    const timeout = window.setTimeout(() => setShareFeedback(null), 4_000);
    return () => window.clearTimeout(timeout);
  }, [shareFeedback]);

  useEffect(() => {
    if (!chatStatus) return;
    const timeout = window.setTimeout(() => setChatStatus(null), 5_000);
    return () => window.clearTimeout(timeout);
  }, [chatStatus]);

  useEffect(() => {
    if (!chatCoolingDown) return;
    const timeout = window.setTimeout(() => setChatCoolingDown(false), 2_000);
    return () => window.clearTimeout(timeout);
  }, [chatCoolingDown]);

  useEffect(() => {
    window.render_game_to_text = () =>
      JSON.stringify({
        coordinateSystem: "Canvas origin is top-left; x increases right and y increases down.",
        release: APP_RELEASE_IDENTITY,
        mode: game?.phase ?? (session?.signedIn ? "lobby-browser" : "signed-out"),
        connection: connectionState,
        effects: {
          reducedMotion,
          playedCardPulse: Boolean(
            game &&
              playedCardFxRevision?.gameId === game.gameId &&
              playedCardFxRevision.revision === game.revision,
          ),
          selfTurnPulse: Boolean(
            game &&
              turnFxRevision?.gameId === game.gameId &&
              turnFxRevision.revision === game.revision,
          ),
        },
        audio: {
          enabled: soundSettings.enabled,
          unlocked: soundDebug.unlocked,
          capabilities: soundCapabilities,
          volume: soundSettings.volume,
          spokenCallouts: soundSettings.spokenCallouts,
          lastCue: soundDebug.lastCue,
          lastCallout: soundDebug.lastCallout,
          lastRevision: soundDebug.lastRevision,
        },
        savedAction: storedCommand
          ? { gameId: storedCommand.gameId, type: storedCommand.command.type }
          : null,
        issueReport: {
          modal: bugReportOpen ? "open" : "closed",
          category: bugReportOpen ? bugReportCategory : null,
          descriptionLength: bugReportOpen
            ? Array.from(bugReportDescription.normalize("NFKC")).length
            : 0,
          diagnostics: bugReportOpen ? bugReportDiagnostics : null,
          outboundAction: bugReportOpen ? "awaiting_explicit_user_click" : null,
        },
        game: game
          ? {
              id: game.gameId,
              code: game.joinCode,
              revision: game.revision,
              turn: game.turnNumber,
              currentPlayer: game.currentPlayerName,
              direction: game.direction,
              activeColor: game.activeColor,
              topDiscard: game.topDiscard ? cardLabel(game.topDiscard) : null,
              pendingDraw: game.pendingDraw?.total ?? 0,
              players: game.players.map((player) => ({
                name: player.displayName,
                cards: player.cardCount,
                status: player.status,
                isSelf: player.isSelf,
                presence:
                  presence?.players.find((entry) => entry.playerId === player.playerId)
                    ?.status ?? null,
              })),
              ownHand: game.hand.map((card) => ({ id: card.id, label: cardLabel(card) })),
              legalActions: game.legalActions,
              winner: game.winner,
              series: game.series,
              coach: getTurnCoach(game, game.players.find((player) => player.isSelf)?.playerId),
              chat: chatEnabled
                ? {
                    visible: chatPanelVisible,
                    tab: sidebarTab,
                    unread: chatUnread,
                    announcements: chatAnnouncements,
                    freeText: chatFreeTextEnabled,
                    liveVoice: chatLiveVoiceEnabled,
                    draftLength: chatDraftGraphemes,
                    latest: visibleChatMessages.slice(-3).map((message) =>
                      message.kind === "text"
                        ? {
                            senderPlayerId: message.senderPlayerId,
                            kind: "text",
                            bodyLength: countChatGraphemes(message.body),
                          }
                        : {
                            senderPlayerId: message.senderPlayerId,
                            kind: message.kind,
                            contentId: message.contentId,
                          },
                    ),
                  }
                : null,
              voice: {
                sheet: voiceSheetOpen ? "open" : "closed",
                status: liveVoiceSnapshot.status,
                microphoneEnabled: liveVoiceSnapshot.microphoneEnabled,
                outputMuted: liveVoiceSnapshot.outputMuted,
                participantCount: liveVoiceSnapshot.participants.length,
                hasError: Boolean(liveVoiceSnapshot.error),
              },
            }
          : null,
      });
    window.advanceTime = (milliseconds: number) => {
      const safe = Math.max(0, Number.isFinite(milliseconds) ? milliseconds : 0);
      testClock.current += safe;
      window.dispatchEvent(new CustomEvent("open-shed-step", { detail: safe }));
      return testClock.current;
    };
    return () => {
      delete window.render_game_to_text;
      delete window.advanceTime;
    };
  }, [
    bugReportCategory,
    bugReportDescription,
    bugReportDiagnostics,
    bugReportOpen,
    chatAnnouncements,
    chatDraftGraphemes,
    chatEnabled,
    chatFreeTextEnabled,
    chatLiveVoiceEnabled,
    chatPanelVisible,
    chatUnread,
    connectionState,
    game,
    liveVoiceSnapshot,
    playedCardFxRevision,
    presence,
    reducedMotion,
    session,
    sidebarTab,
    soundCapabilities,
    soundDebug,
    soundSettings,
    storedCommand,
    turnFxRevision,
    visibleChatMessages,
    voiceSheetOpen,
  ]);

  const enterGame = useCallback((
    view: GameView,
    initialEvents: EventLine[] = [],
    eventCursor = view.revision,
    initialPresence: PresenceSnapshot | null = null,
    initialListing: ViewerListing | null = null,
  ) => {
    if (pollRequestRef.current?.gameId !== view.gameId) {
      pollRequestRef.current?.controller.abort();
      pollRequestRef.current = null;
    }
    gameRef.current = view;
    eventCursorRef.current = { gameId: view.gameId, revision: eventCursor };
    setGame(view);
    setEvents(initialEvents.slice(-12));
    setPresence(initialPresence);
    setListing(initialListing);
    setConnectionState("live");
    setError(null);
    setJoinAlias("");
    setGameInUrl(view.gameId);
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "auto" }));
  }, []);

  const openLobbyBrowser = useCallback(() => {
    pollRequestRef.current?.controller.abort();
    pollRequestRef.current = null;
    gameRef.current = null;
    eventCursorRef.current = null;
    setGame(null);
    setPendingCard(null);
    setChosenColor(null);
    setSwapTargetId(null);
    setDeclareWithPlay(false);
    setEvents([]);
    setPresence(null);
    setListing(null);
    setError(null);
    setGameInUrl(null);
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "auto" }));
    void loadLobbies();
    void loadPublicRooms();
  }, [loadLobbies, loadPublicRooms]);

  const runBusy = useCallback(async (work: () => Promise<void>): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Something went wrong.");
      return false;
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const createLobby = async () => {
    return runBusy(async () => {
      const response = await request<GameSnapshotResponse>("/api/games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandId: commandId(), nickname }),
      });
      enterGame(
        response.view,
        response.events ?? [],
        response.eventCursor ?? response.view.revision,
        response.presence ?? null,
        parseViewerListing(response.listing),
      );
    });
  };

  const joinLobby = async (code = joinCode) => {
    const alias = normalizeRoomAlias(joinAlias);
    if (!isValidRoomAlias(alias)) {
      setError(ROOM_ALIAS_ERROR);
      return false;
    }
    return runBusy(async () => {
      const response = await request<GameSnapshotResponse>("/api/games/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandId: commandId(), joinCode: code, nickname: alias }),
      });
      setNickname(alias);
      enterGame(
        response.view,
        response.events ?? [],
        response.eventCursor ?? response.view.revision,
        response.presence ?? null,
        parseViewerListing(response.listing),
      );
    });
  };

  const openGame = async (gameId: string) => {
    await runBusy(async () => {
      const response = await request<GameSnapshotResponse>(
        `/api/games/${encodeURIComponent(gameId)}`,
      );
      enterGame(
        response.view,
        response.events ?? [],
        response.eventCursor ?? response.view.revision,
        response.presence ?? null,
        parseViewerListing(response.listing),
      );
    });
  };

  const executeStoredCommand = useCallback(async (record: StoredCommand): Promise<boolean> => {
    const commandGame = gameRef.current;
    if (!commandGame || commandGame.gameId !== record.gameId) return false;
    return runBusy(async () => {
      setConnectionState("syncing");
      try {
        const response = await request<{
          view?: GameView;
          events?: EventLine[];
          replayed: boolean;
          listing?: ViewerListing | null;
        }>(`/api/games/${encodeURIComponent(commandGame.gameId)}/commands`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            commandId: record.commandId,
            expectedRevision: record.expectedRevision,
            command: record.command,
          }),
        });
        const responseRevision = response.view?.revision ?? null;
        if (Object.prototype.hasOwnProperty.call(response, "listing")) {
          setListing(parseViewerListing(response.listing));
        }
        const cursorBeforeResponse = eventCursorRef.current;
        const responseAlreadyObserved =
          responseRevision !== null &&
          cursorBeforeResponse?.gameId === commandGame.gameId &&
          cursorBeforeResponse.revision >= responseRevision;
        const currentGame = gameRef.current;
        if (
          record.command.type !== "leave_game" &&
          response.view &&
          currentGame?.gameId === commandGame.gameId
        ) {
          if (response.view.revision > currentGame.revision) {
            gameRef.current = response.view;
            setGame(response.view);
          }
          eventCursorRef.current = {
            gameId: response.view.gameId,
            revision: Math.max(
              cursorBeforeResponse?.gameId === response.view.gameId
                ? cursorBeforeResponse.revision
                : 0,
              response.view.revision,
            ),
          };
        }
        if (
          response.events?.length &&
          gameRef.current?.gameId === commandGame.gameId &&
          !responseAlreadyObserved
        ) {
          setEvents((current) => [...current, ...response.events!].slice(-12));
        }
        setPendingCard(null);
        setChosenColor(null);
        setSwapTargetId(null);
        setDeclareWithPlay(false);
        clearStoredCommand();
        setStoredCommand(null);
        setConnectionState("live");
        if (record.command.type === "leave_game") openLobbyBrowser();
      } catch (failure) {
        const code = (failure as RequestFailure).code;
        const recoverable =
          code === "REQUEST_TIMEOUT" ||
          failure instanceof TypeError ||
          !navigator.onLine;
        if (!recoverable) {
          clearStoredCommand();
          setStoredCommand(null);
        }
        if (code === "VERSION_CONFLICT") {
          await refreshGame(commandGame.gameId);
        }
        if (recoverable) {
          setPendingCard(null);
          setChosenColor(null);
          setSwapTargetId(null);
          setDeclareWithPlay(false);
          setConnectionState(navigator.onLine ? "reconnecting" : "offline");
          throw new Error(
            "Connection interrupted. Your action is saved in this tab and ready to retry.",
          );
        }
        throw failure;
      }
    });
  }, [openLobbyBrowser, refreshGame, request, runBusy]);

  const sendCommand = async (command: V11GameCommand): Promise<boolean> => {
    const commandGame = gameRef.current;
    if (!commandGame) return false;
    const existing = readStoredCommand();
    if (existing && existing.gameId === commandGame.gameId) {
      setStoredCommand(existing);
      setError("Finish retrying the saved action before sending another move.");
      return false;
    }
    const record: StoredCommand = {
      commandId: commandId(),
      command,
      createdAt: commandGame.revision,
      expectedRevision: commandGame.revision,
      gameId: commandGame.gameId,
    };
    writeStoredCommand(record);
    setStoredCommand(record);
    storedRetryKeyRef.current = `${record.commandId}:${reconnectTick}`;
    return executeStoredCommand(record);
  };

  const retryStoredCommand = async (): Promise<boolean> => {
    const record = readStoredCommand();
    if (!record || record.gameId !== gameRef.current?.gameId) return false;
    setStoredCommand(record);
    storedRetryKeyRef.current = `${record.commandId}:${reconnectTick}`;
    return executeStoredCommand(record);
  };

  useEffect(() => {
    if (!session?.signedIn || activeGameId) return;
    const linkedGameId = new URLSearchParams(window.location.search).get("game");
    if (!linkedGameId || deepLinkInFlight.current === linkedGameId) return;
    let cancelled = false;
    deepLinkInFlight.current = linkedGameId;
    setBusy(true);
    void request<GameSnapshotResponse>(
      `/api/games/${encodeURIComponent(linkedGameId)}`,
    )
      .then((response) => {
        if (!cancelled) {
          enterGame(
            response.view,
            response.events ?? [],
            response.eventCursor ?? response.view.revision,
            response.presence ?? null,
            parseViewerListing(response.listing),
          );
        }
      })
      .catch((failure) => {
        if (cancelled) return;
        setError(failure instanceof Error ? failure.message : "Game could not be opened.");
        const code = (failure as RequestFailure).code;
        if (["GAME_EXPIRED", "GAME_NOT_FOUND", "ROOM_CLOSED", "NOT_A_MEMBER"].includes(code ?? "")) {
          setGameInUrl(null);
        }
      })
      .finally(() => {
        if (deepLinkInFlight.current === linkedGameId) deepLinkInFlight.current = null;
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeGameId, enterGame, reconnectTick, request, session?.signedIn]);

  useEffect(() => {
    if (!session?.signedIn || !activeGameId || busy || !navigator.onLine) return;
    const record = readStoredCommand();
    if (!record || record.gameId !== activeGameId) return;
    const retryKey = `${record.commandId}:${reconnectTick}`;
    if (storedRetryKeyRef.current === retryKey) return;
    storedRetryKeyRef.current = retryKey;
    setStoredCommand(record);
    void executeStoredCommand(record);
  }, [activeGameId, busy, executeStoredCommand, reconnectTick, session?.signedIn]);

  const dismissInvite = () => {
    setInviteDialogOpen(false);
    setInviteError(null);
    setJoinAlias("");
    clearJoinFromUrl();
    setInviteCode(null);
  };

  const openPublicJoin = (room: PublicRoomCard, trigger: HTMLButtonElement) => {
    utilityTriggerRef.current = trigger;
    publicJoinMutationRef.current = null;
    setPublicAlias("");
    setPublicJoinError(null);
    setLinkedListingIntent(null);
    setPublicJoinIntent({ kind: "listing", listingId: room.listingId, room });
    setListingInUrl(room.listingId);
  };

  const openQuickJoin = (trigger: HTMLButtonElement) => {
    utilityTriggerRef.current = trigger;
    publicJoinMutationRef.current = null;
    setPublicAlias("");
    setPublicJoinError(null);
    setLinkedListingIntent(null);
    setPublicJoinIntent({ kind: "quick" });
  };

  const closePublicJoin = useCallback(() => {
    const wasListingIntent = publicJoinIntent?.kind === "listing";
    setPublicJoinIntent(null);
    setPublicAlias("");
    setPublicJoinError(null);
    setLinkedListingIntent(null);
    publicJoinMutationRef.current = null;
    if (wasListingIntent) clearListingFromUrl();
    window.requestAnimationFrame(() => utilityTriggerRef.current?.focus());
  }, [publicJoinIntent?.kind]);

  const confirmPublicJoin = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!publicJoinIntent || busy) return;
    const alias = normalizeRoomAlias(publicAlias);
    if (!isValidRoomAlias(alias)) {
      setPublicJoinError(ROOM_ALIAS_ERROR);
      publicAliasInputRef.current?.focus();
      return;
    }
    const path = publicJoinIntent.kind === "quick"
      ? "/api/public/quick-join"
      : `/api/public/rooms/${encodeURIComponent(publicJoinIntent.listingId)}/join`;
    const payload = { alias };
    const fingerprint = JSON.stringify({ path, payload });
    const requestCommandId = publicJoinMutationRef.current?.fingerprint === fingerprint
      ? publicJoinMutationRef.current.commandId
      : commandId();
    publicJoinMutationRef.current = { commandId: requestCommandId, fingerprint };
    setBusy(true);
    setPublicJoinError(null);
    try {
      const response = await request<GameSnapshotResponse>(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandId: requestCommandId, ...payload }),
      });
      publicJoinMutationRef.current = null;
      setPublicJoinIntent(null);
      setPublicJoinError(null);
      setPublicAlias("");
      setLinkedListingIntent(null);
      setNickname(alias);
      clearListingFromUrl();
      enterGame(
        response.view,
        response.events ?? [],
        response.eventCursor ?? response.view.revision,
        response.presence ?? null,
        parseViewerListing(response.listing),
      );
    } catch (failure) {
      const code = (failure as RequestFailure).code;
      if (["DISCOVERY_DISABLED", "FEATURE_DISABLED", "ROUTE_NOT_FOUND"].includes(code ?? "")) {
        setPublicDiscoveryEnabled(false);
        setPublicRooms(null);
        setPublicJoinIntent(null);
        setLinkedListingIntent(null);
        setPublicJoinError(null);
        publicJoinMutationRef.current = null;
        clearListingFromUrl();
      } else {
        setPublicJoinError(publicJoinFailureMessage(code));
        if (
          code !== "REQUEST_TIMEOUT" &&
          !(failure instanceof TypeError) &&
          navigator.onLine
        ) {
          publicJoinMutationRef.current = null;
        }
        void loadPublicRooms();
      }
    } finally {
      setBusy(false);
    }
  };

  const openListingDialog = (
    action: ListingDialogAction,
    trigger: HTMLButtonElement,
  ) => {
    utilityTriggerRef.current = trigger;
    listingMutationRef.current = null;
    setListingDialogAction(action);
    setListingAlias("");
    setListingPace(listing?.pace ?? "casual");
    setListingError(null);
  };

  const closeListingDialog = useCallback(() => {
    setListingDialogAction(null);
    setListingAlias("");
    setListingError(null);
    listingMutationRef.current = null;
    window.requestAnimationFrame(() => utilityTriggerRef.current?.focus());
  }, []);

  const confirmListingChange = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const currentGame = gameRef.current;
    if (!currentGame || !listing || !listingDialogAction || busy) return;
    const alias = normalizeRoomAlias(listingAlias);
    if (listingDialogAction === "publish" && !isValidRoomAlias(alias)) {
      setListingError(ROOM_ALIAS_ERROR);
      publicAliasInputRef.current?.focus();
      return;
    }
    const path = `/api/games/${encodeURIComponent(currentGame.gameId)}/listing`;
    const payload = {
      expectedRevision: currentGame.revision,
      expectedListingVersion: listing.version,
      action: listingDialogAction,
      ...(listingDialogAction === "publish"
        ? { alias, pace: listingPace }
        : {}),
    };
    const fingerprint = JSON.stringify({ path, payload });
    const requestCommandId = listingMutationRef.current?.fingerprint === fingerprint
      ? listingMutationRef.current.commandId
      : commandId();
    listingMutationRef.current = { commandId: requestCommandId, fingerprint };
    setBusy(true);
    setListingError(null);
    try {
      const response = await request<{ listing: unknown; view: GameView }>(
        path,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ commandId: requestCommandId, ...payload }),
        },
      );
      const nextListing = parseViewerListing(response.listing);
      if (!nextListing) {
        setListing(null);
        throw new Error("Public listing is unavailable for this table right now.");
      }
      if (gameRef.current?.gameId === response.view.gameId) {
        const currentCursor = eventCursorRef.current;
        gameRef.current = response.view;
        setGame(response.view);
        eventCursorRef.current = {
          gameId: response.view.gameId,
          revision:
            currentCursor?.gameId === response.view.gameId
              ? currentCursor.revision
              : listingDialogAction === "publish"
                ? Math.max(0, response.view.revision - 1)
                : response.view.revision,
        };
      }
      if (listingDialogAction === "publish") {
        setNickname(alias);
        setChatFreeTextEnabled(false);
        setChatLiveVoiceEnabled(false);
        setChatDraft("");
        setChatDraftError(null);
      }
      setListing(nextListing);
      setListingDialogAction(null);
      setListingAlias("");
      setListingError(null);
      listingMutationRef.current = null;
      window.requestAnimationFrame(() => utilityTriggerRef.current?.focus());
    } catch (failure) {
      const code = (failure as RequestFailure).code;
      if (["DISCOVERY_DISABLED", "FEATURE_DISABLED", "NOT_FOUND", "ROUTE_NOT_FOUND"].includes(code ?? "")) {
        setListing(null);
        setListingDialogAction(null);
        listingMutationRef.current = null;
      } else {
        setListingError(
          failure instanceof Error && !code
            ? failure.message
            : listingFailureMessage(code),
        );
        if (
          code !== "REQUEST_TIMEOUT" &&
          !(failure instanceof TypeError) &&
          navigator.onLine
        ) {
          listingMutationRef.current = null;
        }
        if (code === "VERSION_CONFLICT" || code === "LISTING_VERSION_CONFLICT") {
          void refreshGame(currentGame.gameId);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmInvite = async () => {
    if (!inviteCode) return;
    if (!isValidRoomAlias(joinAlias)) {
      setInviteError(ROOM_ALIAS_ERROR);
      return;
    }
    setInviteError(null);
    const joined = await joinLobby(inviteCode);
    if (joined) {
      setInviteDialogOpen(false);
      setInviteCode(null);
      return;
    }
    setInviteError(
      "We couldn’t join that table. It may be full, expired, or already in play. You can retry or enter another code.",
    );
  };

  const shareInvite = async (preferNativeShare = true) => {
    const current = gameRef.current;
    if (!current) return;
    if (current.phase !== "lobby") {
      setShareFeedback("Invites close when the game starts.");
      return;
    }
    const inviteUrl = new URL(window.location.origin);
    inviteUrl.searchParams.set("join", current.joinCode);
    try {
      if (preferNativeShare && typeof navigator.share === "function") {
        await navigator.share({
          title: "Join my Open Shed table",
          text: `Join table ${current.joinCode} in Open Shed.`,
          url: inviteUrl.toString(),
        });
        setShareFeedback("Invite shared.");
      } else {
        await navigator.clipboard.writeText(inviteUrl.toString());
        setShareFeedback("Invite link copied.");
      }
    } catch (failure) {
      if ((failure as Error).name === "AbortError") return;
      try {
        await navigator.clipboard.writeText(inviteUrl.toString());
        setShareFeedback("Invite link copied instead.");
      } catch {
        setShareFeedback("Couldn’t share automatically. Copy the table code instead.");
      }
    }
  };

  const copyLobbyCode = async () => {
    const code = gameRef.current?.joinCode;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setShareFeedback("Table code copied.");
    } catch {
      setShareFeedback("Couldn’t copy automatically. Select the code and copy it.");
    }
  };

  const openGuide = (topic: GuideTopic, trigger?: HTMLButtonElement) => {
    utilityTriggerRef.current = trigger ?? null;
    setGuideTopic(topic);
  };

  const closeGuide = useCallback(() => {
    setGuideTopic(null);
    window.requestAnimationFrame(() => utilityTriggerRef.current?.focus());
  }, []);

  const openSoundDialog = (trigger: HTMLButtonElement) => {
    soundTriggerRef.current = trigger;
    syncSoundState();
    setSoundStatus(null);
    setSoundDialogOpen(true);
  };

  const closeSoundDialog = useCallback(() => {
    setSoundDialogOpen(false);
    window.requestAnimationFrame(() => soundTriggerRef.current?.focus());
  }, []);

  const changeSoundEnabled = async () => {
    const controller = audioControllerRef.current;
    if (!controller) return;
    try {
      const current = controller.getSettings();
      if (current.enabled && controller.getDebugState().unlocked) {
        await controller.setEnabled(false);
        setSoundStatus("Game sound muted.");
      } else {
        const unlocked = current.enabled
          ? await controller.resumeFromGesture()
          : await controller.setEnabled(true);
        const previewed = unlocked ? await controller.preview() : false;
        setSoundStatus(
          unlocked
            ? previewed
              ? "Sound enabled. Preview played."
              : "Sound enabled. Preview is unavailable with the current options."
            : "The browser did not allow audio yet. Tap Enable now to try again.",
        );
      }
    } catch {
      setSoundStatus("Sound could not be changed in this browser.");
    }
    syncSoundState();
  };

  const turnSoundOff = async () => {
    const controller = audioControllerRef.current;
    if (!controller) return;
    await controller.setEnabled(false);
    setSoundStatus("Game sound turned off.");
    syncSoundState();
  };

  const changeSoundVolume = (volume: number) => {
    const controller = audioControllerRef.current;
    if (!controller) return;
    controller.setVolume(volume);
    syncSoundState();
  };

  const changeSpokenCallouts = () => {
    const controller = audioControllerRef.current;
    if (!controller) return;
    const enabled = !controller.getSettings().spokenCallouts;
    controller.setSpokenCallouts(enabled);
    setSoundStatus(enabled ? "Spoken card callouts enabled." : "Spoken card callouts muted.");
    syncSoundState();
  };

  const previewSound = async () => {
    const controller = audioControllerRef.current;
    if (!controller) return;
    try {
      const current = controller.getSettings();
      const unlocked = current.enabled
        ? await controller.resumeFromGesture()
        : await controller.setEnabled(true);
      const previewed = unlocked ? await controller.preview() : false;
      setSoundStatus(
        previewed
          ? "Preview played."
          : "The browser could not play the preview. Tap again or check device volume.",
      );
    } catch {
      setSoundStatus("The preview could not play in this browser.");
    }
    syncSoundState();
  };

  const privateBugReportValues = (current: GameView | null) => {
    return createPrivateBugReportTerms({
      names: [
        session?.displayName ?? "",
        nickname,
        ...(current?.players.map((player) => player.displayName) ?? []),
      ],
      secrets: [
        current?.gameId ?? "",
        current?.joinCode ?? "",
        current?.currentPlayerId ?? "",
        current?.rouletteTargetId ?? "",
        current?.forcedCardId ?? "",
        current?.topDiscard?.id ?? "",
        ...(current?.players.map((player) => player.playerId) ?? []),
        ...(current?.hand.map((card) => card.id) ?? []),
      ],
    });
  };

  const currentBugReportDraft = () => {
    if (!bugReportDiagnostics) {
      return { ok: false as const, error: "Safe diagnostics are not ready. Close and reopen the report." };
    }
    const validation = validateBugReportDescription(
      bugReportDescription,
      bugReportPrivateCanaries,
    );
    if (!validation.ok) return validation;
    return {
      ok: true as const,
      input: {
        category: bugReportCategory,
        description: validation.value,
        diagnostics: bugReportDiagnostics,
      },
    };
  };

  const openBugReport = (trigger: HTMLButtonElement) => {
    const current = gameRef.current;
    const selfPlayerId = current?.players.find((player) => player.isSelf)?.playerId;
    bugReportTriggerRef.current = trigger;
    setBugReportCategory("turn_stuck");
    setBugReportDescription("");
    setBugReportError(null);
    setBugReportStatus(null);
    setBugReportPrivateCanaries(privateBugReportValues(current));
    setBugReportDiagnostics(createSafeBugReportDiagnostics({
      phase: current?.phase ?? "lobby-browser",
      revision: current?.revision ?? null,
      connection: connectionState,
      currentTurnIsSelf: current?.currentPlayerId
        ? current.currentPlayerId === selfPlayerId
        : null,
      activeColor: current?.activeColor ?? null,
      pendingDraw: current?.pendingDraw
        ? { total: current.pendingDraw.total, minimum: current.pendingDraw.minimum }
        : null,
      direction: current ? (current.direction === 1 ? "clockwise" : "counterclockwise") : null,
      playerCount: current?.players.filter((player) => player.status !== "left").length ?? 0,
      viewportBucket: viewportBucket(window.innerWidth),
      rouletteChoice: current?.rouletteTargetId
        ? current.rouletteTargetId === selfPlayerId
          ? "self"
          : "other"
        : "none",
      legalActions: createSafeBugReportLegalActions({
        canSetReady: current?.legalActions.canSetReady ?? false,
        canStart: current?.legalActions.canStart ?? false,
        canPlayCard: Boolean(current?.legalActions.playableCardIds.length),
        canDrawUntilPlayable: current?.legalActions.canDrawUntilPlayable ?? false,
        canAcceptPenalty: current?.legalActions.canAcceptPenalty ?? false,
        canChooseRouletteColor: current?.legalActions.canChooseRouletteColor ?? false,
        canDeclareUno: current?.legalActions.canDeclareUno ?? false,
        canCatchUno: Boolean(current?.legalActions.catchablePlayerIds.length),
        canRematch: current?.legalActions.canRematch ?? false,
        canLeave: current?.legalActions.canLeave ?? false,
      }),
      recentEventKinds: events.map((event) => event.type),
    }));
    setBugReportOpen(true);
  };

  const closeBugReport = useCallback(() => {
    setBugReportOpen(false);
    setBugReportPrivateCanaries([]);
    setBugReportError(null);
    setBugReportStatus(null);
    window.requestAnimationFrame(() => bugReportTriggerRef.current?.focus());
  }, []);

  const copyBugReport = async () => {
    const draft = currentBugReportDraft();
    if (!draft.ok) {
      setBugReportError(draft.error);
      bugReportDescriptionRef.current?.focus();
      return;
    }
    try {
      await navigator.clipboard.writeText(buildBugReportDraft(draft.input).text);
      setBugReportError(null);
      setBugReportStatus(
        "Privacy-safe draft copied. Nothing has been submitted.",
      );
    } catch {
      setBugReportError("This browser could not copy the report. Use Review on GitHub instead.");
    }
  };

  const requestInactiveRemoval = (playerId: string, trigger: HTMLButtonElement) => {
    utilityTriggerRef.current = trigger;
    setRemoveTargetId(playerId);
  };

  const closeInactiveRemoval = useCallback(() => {
    setRemoveTargetId(null);
    window.requestAnimationFrame(() => utilityTriggerRef.current?.focus());
  }, []);

  const confirmInactiveRemoval = async () => {
    if (!removeTargetId) return;
    const targetPlayerId = removeTargetId;
    setRemoveTargetId(null);
    const removed = await sendCommand({
      type: "remove_inactive_player",
      targetPlayerId,
    });
    if (!removed && !readStoredCommand()) setError("That player could not be removed. Refresh the table and try again.");
  };

  const leaveTable = async () => {
    if (!gameRef.current) return;
    const left = await sendCommand({ type: "leave_game" });
    if (left) openLobbyBrowser();
  };

  const claimHost = async () => {
    setHostClaimPending(true);
    try {
      await sendCommand({ type: "claim_host" });
    } finally {
      setHostClaimPending(false);
    }
  };

  const openTestPlayerDialog = (trigger: HTMLButtonElement) => {
    if (pendingCard || testPlayerDialogOpen || busy) return;
    testPlayerTriggerRef.current = trigger;
    setTestPlayerName(nickname || session?.displayName || "Player");
    setTestPlayerNameError(null);
    setTestPlayerDialogOpen(true);
  };

  const closeTestPlayerDialog = useCallback(() => {
    setTestPlayerDialogOpen(false);
    setTestPlayerNameError(null);
    window.requestAnimationFrame(() => testPlayerTriggerRef.current?.focus());
  }, []);

  const switchLocalPlayer = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (testPlayerSwitchingRef.current) return;
    const name = testPlayerName.trim().replace(/\s+/g, " ");
    if (!name) {
      setTestPlayerNameError("Enter a player name.");
      testPlayerInputRef.current?.focus();
      return;
    }
    testPlayerSwitchingRef.current = true;
    setSwitchingTestPlayer(true);
    setTestPlayerNameError(null);
    try {
      localStorage.setItem(
        "open-shed-dev-identity",
        JSON.stringify({ id: crypto.randomUUID(), name: name.slice(0, 28) }),
      );
      window.location.reload();
    } catch {
      testPlayerSwitchingRef.current = false;
      setSwitchingTestPlayer(false);
      setTestPlayerNameError("This browser could not save the test player. Try again.");
      testPlayerInputRef.current?.focus();
    }
  };

  const completePendingPlay = () => {
    if (!pendingCard) return;
    void sendCommand({
      type: "play_card",
      cardId: pendingCard.id,
      chosenColor: isWild(pendingCard) && pendingCard.kind !== "wild_color_roulette"
        ? chosenColor ?? undefined
        : undefined,
      swapTargetId:
        pendingCard.kind === "number" && pendingCard.number === 7
          ? swapTargetId ?? undefined
          : undefined,
      declareUno: declareWithPlay,
    });
  };

  const closePendingChoice = useCallback(() => {
    setPendingCard(null);
    setChosenColor(null);
    setSwapTargetId(null);
    setDeclareWithPlay(false);
    window.requestAnimationFrame(() => choiceTriggerRef.current?.focus());
  }, []);

  const selectCard = (card: Card, trigger: HTMLButtonElement) => {
    if (!game?.legalActions.playableCardIds.includes(card.id)) return;
    const needsColor = isWild(card) && card.kind !== "wild_color_roulette";
    const needsTarget = card.kind === "number" && card.number === 7;
    const needsUnoChoice = handCountAfterPlay(game, card, null) === 1;
    if (needsColor || needsTarget || needsUnoChoice) {
      choiceTriggerRef.current = trigger;
      setPendingCard(card);
      setChosenColor(null);
      setSwapTargetId(null);
      setDeclareWithPlay(false);
      return;
    }
    void sendCommand({ type: "play_card", cardId: card.id, declareUno: false });
  };

  const selectSidebarTab = (tab: SidebarTab) => {
    chatTabPreferenceRef.current = true;
    setSidebarTab(tab);
    window.sessionStorage.setItem(CHAT_TAB_STORAGE_KEY, tab);
    if (tab === "chat") setChatUnread(0);
  };

  const toggleChatAnnouncements = () => {
    setChatAnnouncements((current) => {
      const next = !current;
      window.sessionStorage.setItem(
        CHAT_ANNOUNCEMENTS_STORAGE_KEY,
        next ? "on" : "off",
      );
      return next;
    });
  };

  const hideChatFeature = () => {
    setChatEnabled(false);
    setChatFreeTextEnabled(false);
    setChatLiveVoiceEnabled(false);
    setChatMessages([]);
    setChatUnread(0);
    setChatError(null);
    setChatStatus(null);
    setChatDialog(null);
    setChatCoolingDown(false);
    setChatDraft("");
    setChatDraftError(null);
    chatMessageIdsRef.current = new Set();
    chatSendMutationRef.current = null;
    chatReportMutationRef.current = null;
  };

  const sendCuratedChat = async (
    kind: CuratedChatKind,
    contentId: ChatContentId,
  ) => {
    const currentGame = gameRef.current;
    if (!currentGame || !chatEnabled || chatSending || chatCoolingDown) return;
    const fingerprint = JSON.stringify({
      gameId: currentGame.gameId,
      kind,
      contentId,
    });
    const requestCommandId =
      chatSendMutationRef.current?.fingerprint === fingerprint
        ? chatSendMutationRef.current.commandId
        : commandId();
    chatSendMutationRef.current = { commandId: requestCommandId, fingerprint };
    setChatSending(true);
    setChatError(null);
    setChatStatus(null);
    try {
      await request<unknown>(
        `/api/games/${encodeURIComponent(currentGame.gameId)}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ commandId: requestCommandId, kind, contentId }),
        },
      );
      if (gameRef.current?.gameId === currentGame.gameId) {
        chatSendMutationRef.current = null;
        setChatCoolingDown(true);
        setChatStatus("Message sent.");
        setChatRefreshTick((current) => current + 1);
      }
    } catch (failure) {
      const code = (failure as RequestFailure).code;
      if (
        ["COMMUNICATION_DISABLED", "FEATURE_DISABLED", "ROUTE_NOT_FOUND"].includes(
          code ?? "",
        )
      ) {
        hideChatFeature();
      } else {
        const recoverable =
          code === "REQUEST_TIMEOUT" || failure instanceof TypeError || !navigator.onLine;
        if (!recoverable) chatSendMutationRef.current = null;
        setChatError(
          code === "RATE_LIMITED"
            ? "Wait a moment before sending again."
            : recoverable
              ? "Chat lost the response. Retry the same message safely. Your game actions still work."
              : "That message did not send. Your game actions are unaffected.",
        );
      }
    } finally {
      setChatSending(false);
    }
  };

  const sendFreeTextChat = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const currentGame = gameRef.current;
    if (
      !currentGame ||
      !chatEnabled ||
      !chatFreeTextEnabled ||
      chatSending ||
      chatCoolingDown
    ) {
      return;
    }
    if (!preparedChatDraft) {
      setChatDraftError(
        chatDraftGraphemes > CHAT_TEXT_MAX_GRAPHEMES
          ? `Shorten this message to ${CHAT_TEXT_MAX_GRAPHEMES} visible characters.`
          : chatDraft.trim()
            ? "Remove unsupported control characters before sending."
            : "Type a message before sending.",
      );
      return;
    }

    const fingerprint = JSON.stringify({
      gameId: currentGame.gameId,
      kind: "text",
      body: preparedChatDraft,
    });
    const requestCommandId =
      chatSendMutationRef.current?.fingerprint === fingerprint
        ? chatSendMutationRef.current.commandId
        : commandId();
    chatSendMutationRef.current = { commandId: requestCommandId, fingerprint };
    setChatSending(true);
    setChatError(null);
    setChatDraftError(null);
    setChatStatus(null);
    try {
      await request<unknown>(
        `/api/games/${encodeURIComponent(currentGame.gameId)}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            commandId: requestCommandId,
            kind: "text",
            body: preparedChatDraft,
          }),
        },
      );
      if (gameRef.current?.gameId === currentGame.gameId) {
        chatSendMutationRef.current = null;
        setChatDraft("");
        setChatCoolingDown(true);
        setChatStatus("Message sent.");
        setChatRefreshTick((current) => current + 1);
      }
    } catch (failure) {
      const code = (failure as RequestFailure).code;
      if (
        ["FREE_TEXT_DISABLED", "FREE_TEXT_UNAVAILABLE"].includes(code ?? "")
      ) {
        chatSendMutationRef.current = null;
        setChatFreeTextEnabled(false);
        if (code === "FREE_TEXT_UNAVAILABLE") setChatLiveVoiceEnabled(false);
        setChatDraft("");
        setChatDraftError(null);
        setChatError(
          "Private free text is no longer available at this table. Quick phrases still work.",
        );
        setChatRefreshTick((current) => current + 1);
      } else if (
        ["COMMUNICATION_DISABLED", "FEATURE_DISABLED", "ROUTE_NOT_FOUND"].includes(
          code ?? "",
        )
      ) {
        hideChatFeature();
      } else {
        const recoverable =
          code === "REQUEST_TIMEOUT" || failure instanceof TypeError || !navigator.onLine;
        if (!recoverable) chatSendMutationRef.current = null;
        setChatDraftError(
          code === "CONTACT_DETAILS_NOT_ALLOWED"
            ? "Links and contact details aren’t allowed in table chat."
            : code === "INVALID_FREE_TEXT"
              ? `Use 1–${CHAT_TEXT_MAX_GRAPHEMES} visible characters and remove hidden control characters.`
              : code === "RATE_LIMITED"
            ? "Wait a moment before sending again."
            : recoverable
              ? "The response was interrupted. Retry this same message safely."
              : "That message did not send. Your game actions are unaffected.",
        );
      }
    } finally {
      setChatSending(false);
    }
  };

  const openVoiceSheet = (trigger: HTMLButtonElement) => {
    voiceSheetTriggerRef.current = trigger;
    liveVoiceControllerRef.current?.openPrejoin();
    setVoiceSheetOpen(true);
  };

  const closeVoiceSheet = useCallback(() => {
    setVoiceSheetOpen(false);
    window.requestAnimationFrame(() => voiceSheetTriggerRef.current?.focus());
  }, []);

  const joinLiveVoice = async () => {
    await liveVoiceControllerRef.current?.join();
  };

  const toggleLiveMicrophone = async () => {
    const controller = liveVoiceControllerRef.current;
    if (!controller) return;
    await controller.setMicrophoneEnabled(!controller.getSnapshot().microphoneEnabled);
  };

  const leaveLiveVoice = async () => {
    const controller = liveVoiceControllerRef.current;
    if (!controller) return;
    await controller.leave();
    if (chatLiveVoiceEnabled) controller.markAvailable();
  };

  const toggleLiveVoiceOutput = () => {
    const controller = liveVoiceControllerRef.current;
    if (!controller) return;
    controller.setOutputMuted(!controller.getSnapshot().outputMuted);
  };

  const resumeLiveVoiceAudio = async () => {
    await liveVoiceControllerRef.current?.resumeAudio();
  };

  const openChatDialog = (
    action: ChatModerationAction,
    message: ChatMessage,
    trigger: HTMLButtonElement,
  ) => {
    chatDialogTriggerRef.current = trigger;
    setChatReportReason("harassment");
    setChatError(null);
    setChatDialog({
      action,
      playerId: message.senderPlayerId,
      displayName: message.senderDisplayName,
      message,
    });
  };

  const openVoiceBlockDialog = (
    participant: LiveVoiceSnapshot["participants"][number],
    trigger: HTMLButtonElement,
  ) => {
    if (participant.self) return;
    chatDialogTriggerRef.current = trigger;
    setVoiceSheetOpen(false);
    setChatError(null);
    setChatDialog({
      action: "block",
      playerId: participant.playerId,
      displayName: participant.displayName,
      message: null,
    });
  };

  const closeChatDialog = useCallback(() => {
    setChatDialog(null);
    setChatModerationBusy(false);
    window.requestAnimationFrame(() => {
      if (chatDialogTriggerRef.current?.isConnected) {
        chatDialogTriggerRef.current.focus();
      } else {
        document.getElementById("chat-tab")?.focus();
      }
    });
  }, []);

  const changeChatRestriction = async (
    restriction: "mute" | "block",
    playerId: string,
    displayName: string,
    enabled: boolean,
  ): Promise<boolean> => {
    const currentGame = gameRef.current;
    if (!currentGame || !chatEnabled || chatModerationBusy) return false;
    setChatModerationBusy(true);
    setChatError(null);
    setChatStatus(null);
    try {
      await request<unknown>(
        `/api/games/${encodeURIComponent(currentGame.gameId)}/players/${encodeURIComponent(playerId)}/${restriction}`,
        {
          method: enabled ? "PUT" : "DELETE",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      );
      const update = restriction === "mute" ? setMutedChatPlayers : setBlockedChatPlayers;
      update((current) => {
        const next = { ...current };
        if (enabled) next[playerId] = displayName;
        else delete next[playerId];
        return next;
      });
      if (restriction === "block" && enabled) {
        await liveVoiceControllerRef.current?.leave();
      }
      setChatUnread(0);
      setChatStatus(
        enabled
          ? `${displayName} is now ${restriction === "mute" ? "muted" : "blocked"}.`
          : `${displayName} is no longer ${restriction === "mute" ? "muted" : "blocked"}.`,
      );
      return true;
    } catch (failure) {
      const code = (failure as RequestFailure).code;
      if (
        ["COMMUNICATION_DISABLED", "FEATURE_DISABLED", "ROUTE_NOT_FOUND"].includes(
          code ?? "",
        )
      ) {
        hideChatFeature();
      } else {
        setChatError(`Could not ${enabled ? "apply" : "remove"} that ${restriction}.`);
      }
      return false;
    } finally {
      setChatModerationBusy(false);
    }
  };

  const confirmChatModeration = async () => {
    const currentDialog = chatDialog;
    if (!currentDialog || chatModerationBusy) return;
    if (currentDialog.action === "report") {
      if (!currentDialog.message) return;
      const fingerprint = JSON.stringify({
        messageId: currentDialog.message.id,
        reason: chatReportReason,
      });
      const requestCommandId =
        chatReportMutationRef.current?.fingerprint === fingerprint
          ? chatReportMutationRef.current.commandId
          : commandId();
      chatReportMutationRef.current = { commandId: requestCommandId, fingerprint };
      setChatModerationBusy(true);
      setChatError(null);
      setChatStatus(null);
      try {
        await request<unknown>(
          `/api/messages/${encodeURIComponent(currentDialog.message.id)}/report`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              commandId: requestCommandId,
              reason: chatReportReason,
            }),
          },
        );
        chatReportMutationRef.current = null;
        setChatStatus("Report received. Thank you for helping keep the table safe.");
        closeChatDialog();
      } catch (failure) {
        const code = (failure as RequestFailure).code;
        if (
          ["COMMUNICATION_DISABLED", "FEATURE_DISABLED", "ROUTE_NOT_FOUND"].includes(
            code ?? "",
          )
        ) {
          hideChatFeature();
        } else {
          const recoverable =
            code === "REQUEST_TIMEOUT" || failure instanceof TypeError || !navigator.onLine;
          if (!recoverable) chatReportMutationRef.current = null;
          setChatError(
            recoverable
              ? "The report response was interrupted. Retry safely with the same reason."
              : "The report could not be sent. Please try again.",
          );
        }
      } finally {
        setChatModerationBusy(false);
      }
      return;
    }

    const changed = await changeChatRestriction(
      currentDialog.action,
      currentDialog.playerId,
      currentDialog.displayName,
      true,
    );
    if (changed) closeChatDialog();
  };

  const self = game?.players.find((player) => player.isSelf) ?? null;
  const liveVoiceJoined = [
    "joined_muted",
    "joined_live",
    "requesting_permission",
    "permission_denied",
    "listen_only",
    "reconnecting",
  ].includes(liveVoiceSnapshot.status) || liveVoiceSnapshot.participants.length > 0;
  const liveVoiceBusy = ["joining", "requesting_permission"].includes(
    liveVoiceSnapshot.status,
  );
  const soundAvailable = soundCapabilities.effects || soundCapabilities.speech;
  const soundControlState = !soundSettings.enabled
    ? "off"
    : soundDebug.unlocked
      ? "on"
      : "ready";
  const soundControlLabel = soundControlState === "off"
    ? "Sound off"
    : soundControlState === "ready"
      ? "Sound ready"
      : "Sound on";
  const isSelfTurn = Boolean(
    game?.phase === "playing" && self && game.currentPlayerId === self.playerId,
  );
  const activeOpponents =
    game?.players.filter((player) => !player.isSelf && player.status === "active") ?? [];
  const activePlayers = game?.players.filter((player) => player.status === "active") ?? [];
  const notReadyPlayers = activePlayers.filter((player) => !player.ready);
  const lobbyReadiness = game?.phase === "lobby"
    ? activePlayers.length < 2
      ? "Invite at least one more player to begin."
      : notReadyPlayers.length
        ? `${formatNameList(notReadyPlayers.map((player) => player.displayName))} ${notReadyPlayers.length === 1 ? "still needs" : "still need"} to ready up.`
        : game.isHost
          ? "Everyone is ready. Start when your table is set."
          : "Everyone is ready. Waiting for the host to start."
    : null;
  const turnCoach = game ? getTurnCoach(game, self?.playerId) : null;
  const hasTurnActions = Boolean(
    game?.phase === "playing" &&
    (game.legalActions.canChooseRouletteColor ||
      game.legalActions.canAcceptPenalty ||
      game.legalActions.canDrawUntilPlayable ||
      game.legalActions.canDeclareUno ||
      game.legalActions.catchablePlayerIds.length),
  );
  const canRematch = Boolean(
    game &&
    (game.legalActions as GameView["legalActions"] & { canRematch?: boolean }).canRematch,
  );
  const hostClaimSaved = Boolean(
    storedCommand?.gameId === game?.gameId &&
    storedCommand?.command.type === "claim_host",
  );
  const rankedSeriesScores = game
    ? rankSeriesScores(game.series.scores, game.players)
    : [];
  const nextRoundNumber = game ? game.series.roundNumber + 1 : 1;
  const removeTarget = game?.players.find((player) => player.playerId === removeTargetId) ?? null;
  const publicJoinRoom = publicJoinIntent?.kind === "listing"
    ? publicJoinIntent.room ?? publicRooms?.rooms.find(
        (room) => room.listingId === publicJoinIntent.listingId,
      ) ?? null
    : null;
  const actionPending =
    busy || Boolean(storedCommand && storedCommand.gameId === game?.gameId);
  const pendingCanConfirm = useMemo(() => {
    if (!pendingCard) return false;
    if (isWild(pendingCard) && pendingCard.kind !== "wild_color_roulette" && !chosenColor) {
      return false;
    }
    if (pendingCard.kind === "number" && pendingCard.number === 7 && !swapTargetId) {
      return false;
    }
    return true;
  }, [chosenColor, pendingCard, swapTargetId]);
  const pendingWouldLeaveOne = useMemo(
    () => game && pendingCard
      ? handCountAfterPlay(game, pendingCard, swapTargetId) === 1
      : false,
    [game, pendingCard, swapTargetId],
  );
  const modalOpen =
    Boolean(pendingCard) ||
    testPlayerDialogOpen ||
    soundDialogOpen ||
    bugReportOpen ||
    inviteDialogOpen ||
    Boolean(publicJoinIntent) ||
    Boolean(listingDialogAction) ||
    Boolean(guideTopic) ||
    Boolean(removeTargetId) ||
    Boolean(chatDialog) ||
    voiceSheetOpen;
  const bugReportIssueLink = (() => {
    if (!bugReportOpen) return { href: null, error: null };
    const draft = currentBugReportDraft();
    if (!draft.ok) return { href: null, error: draft.error };
    try {
      return { href: buildBugReportIssueUrl(draft.input), error: null };
    } catch (failure) {
      return {
        href: null,
        error:
          failure instanceof Error && failure.message === "BUG_REPORT_URL_TOO_LONG"
            ? "This draft is too long for a safe GitHub link. Shorten the description or use Copy report."
            : "The public GitHub draft could not be prepared. Use Copy report instead.",
      };
    }
  })();

  useEffect(() => {
    if (!pendingCard) return;
    const dialog = choiceDialogRef.current;
    if (!dialog) return;
    const focusables = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hidden);
    const frame = window.requestAnimationFrame(() => {
      (focusables()[0] ?? dialog).focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePendingChoice();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closePendingChoice, pendingCard]);

  useEffect(() => {
    if (!testPlayerDialogOpen) return;
    const dialog = testPlayerDialogRef.current;
    if (!dialog) return;
    const focusables = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hidden);
    const frame = window.requestAnimationFrame(() => {
      testPlayerInputRef.current?.focus();
      testPlayerInputRef.current?.select();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeTestPlayerDialog();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closeTestPlayerDialog, testPlayerDialogOpen]);

  useEffect(() => {
    if (
      !inviteDialogOpen &&
      !publicJoinIntent &&
      !listingDialogAction &&
      !guideTopic &&
      !removeTargetId
    ) return;
    const dialog = utilityDialogRef.current;
    if (!dialog) return;
    const focusables = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [href], summary, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hidden);
    const frame = window.requestAnimationFrame(() => {
      (focusables()[0] ?? dialog).focus();
    });
    const closeUtility = () => {
      if (inviteDialogOpen) dismissInvite();
      else if (publicJoinIntent) closePublicJoin();
      else if (listingDialogAction) closeListingDialog();
      else if (removeTargetId) closeInactiveRemoval();
      else closeGuide();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeUtility();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [
    closeGuide,
    closeInactiveRemoval,
    closeListingDialog,
    closePublicJoin,
    guideTopic,
    inviteDialogOpen,
    listingDialogAction,
    publicJoinIntent,
    removeTargetId,
  ]);

  useEffect(() => {
    if (!chatDialog) return;
    const dialog = chatDialogRef.current;
    if (!dialog) return;
    const focusables = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hidden);
    const frame = window.requestAnimationFrame(() => {
      (focusables()[0] ?? dialog).focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeChatDialog();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items.at(-1)!;
      if (
        event.shiftKey &&
        (document.activeElement === first || !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [chatDialog, closeChatDialog]);

  useEffect(() => {
    if (!voiceSheetOpen) return;
    const dialog = voiceSheetRef.current;
    if (!dialog) return;
    const focusables = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hidden);
    const frame = window.requestAnimationFrame(() => {
      (focusables()[0] ?? dialog).focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeVoiceSheet();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items.at(-1)!;
      if (
        event.shiftKey &&
        (document.activeElement === first || !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closeVoiceSheet, voiceSheetOpen]);

  useEffect(() => {
    if (!soundDialogOpen) return;
    const dialog = soundDialogRef.current;
    if (!dialog) return;
    const focusables = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hidden);
    const frame = window.requestAnimationFrame(() => {
      (focusables()[0] ?? dialog).focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSoundDialog();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items.at(-1)!;
      if (
        event.shiftKey &&
        (document.activeElement === first || !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closeSoundDialog, soundDialogOpen]);

  useEffect(() => {
    if (!bugReportOpen) return;
    const dialog = bugReportDialogRef.current;
    if (!dialog) return;
    const focusables = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), textarea:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hidden);
    const frame = window.requestAnimationFrame(() => {
      (bugReportDescriptionRef.current ?? focusables()[0] ?? dialog).focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeBugReport();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items.at(-1)!;
      if (
        event.shiftKey &&
        (document.activeElement === first || !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [bugReportOpen, closeBugReport]);

  if (!session) {
    return (
      <main className="loading-screen" role="status">
        <span className="loading-dot" />
        Preparing the table…
      </main>
    );
  }

  if (!session.signedIn) {
    return <SignedOutLanding signInPath={resolvedSignInPath} />;
  }

  return (
    <main className="open-shed-app">
      <header className="app-header" inert={modalOpen ? true : undefined}>
        <button className="wordmark" onClick={openLobbyBrowser} aria-label="Open lobby browser">
          <span>OPEN</span>
          <span>SHED</span>
        </button>
        <div className={`header-note connection-${connectionState}`} aria-live="polite">
          <span className="status-pip" />
          {connectionLabel(connectionState)}
        </div>
        <div className="header-account">
          <span>{nickname || session.displayName}</span>
          <button
            className="text-button header-guide-button"
            disabled={busy || Boolean(pendingCard)}
            aria-label="Rules and cards"
            onClick={(event) => openGuide("rules", event.currentTarget)}
          >
            <span className="header-mobile-long">Rules &amp; cards</span>
            <span className="header-mobile-short">Rules</span>
          </button>
          <button
            className="text-button sound-control-button"
            data-state={soundControlState}
            disabled={busy || Boolean(pendingCard)}
            aria-haspopup="dialog"
            aria-label={`${soundControlLabel}. Open sound settings.`}
            onClick={(event) => openSoundDialog(event.currentTarget)}
          >
            {soundControlLabel}
          </button>
          <button
            className="text-button header-issue-button"
            disabled={busy || Boolean(pendingCard)}
            aria-haspopup="dialog"
            aria-label="Report an issue"
            onClick={(event) => openBugReport(event.currentTarget)}
          >
            <span className="header-mobile-long">Report issue</span>
            <span className="header-mobile-short">Report</span>
          </button>
          {session.development ? (
            <button
              id="switch-test-player-button"
              className="text-button"
              disabled={busy || Boolean(pendingCard)}
              onClick={(event) => openTestPlayerDialog(event.currentTarget)}
            >
              Switch test player
            </button>
          ) : (
            <a
              className="text-button"
              href="/signout-with-chatgpt?return_to=/"
              aria-label="Sign out"
            >
              <span className="header-mobile-long">Sign out</span>
              <span className="header-mobile-short">Exit</span>
            </a>
          )}
        </div>
      </header>

      {error ? (
        <div className="error-banner" role="alert" inert={modalOpen ? true : undefined}>
          <span>{error}</span>
          <div className="error-banner-actions">
            {storedCommand && storedCommand.gameId === game?.gameId ? (
              <button
                className="error-retry"
                disabled={busy || connectionState === "offline"}
                onClick={() => void retryStoredCommand()}
              >
                Retry saved action
              </button>
            ) : null}
            <button onClick={() => setError(null)} aria-label="Dismiss error">×</button>
          </div>
        </div>
      ) : null}

      <div className="app-view" inert={modalOpen ? true : undefined}>
        <div
          className={`mobile-connection-note connection-${connectionState}`}
          aria-live="polite"
        >
          <span className="status-pip" />
          {connectionLabel(connectionState)}
        </div>
        {!game ? (
          <LobbyBrowser
            nickname={nickname}
            setNickname={setNickname}
            joinAlias={joinAlias}
            setJoinAlias={setJoinAlias}
            joinCode={joinCode}
            setJoinCode={setJoinCode}
            lobbies={lobbies}
            publicRooms={publicRooms}
            busy={busy}
            createLobby={() => void createLobby()}
            joinLobby={(code) => void joinLobby(code)}
            openGame={(id) => void openGame(id)}
            openPublicJoin={openPublicJoin}
            openQuickJoin={openQuickJoin}
            refresh={() => {
              void loadLobbies();
              void loadPublicRooms();
            }}
            openGuide={openGuide}
          />
        ) : (
          <section
            className="game-layout"
            aria-label="Current multiplayer game"
          >
          <div className="table-column">
            <div
              className={`table-status coach-${turnCoach?.tone ?? "neutral"} ${isSelfTurn ? "is-self-turn" : ""} ${turnFxRevision?.gameId === game.gameId && turnFxRevision.revision === game.revision ? "has-turn-pulse" : ""}`.trim()}
              aria-live="polite"
            >
              <span className="eyebrow">{game.phase === "lobby" ? "Lobby" : game.phase === "complete" ? "Result" : "Current turn"}</span>
              <strong>{turnCoach?.title}</strong>
              <div className="table-status-side">
                {isSelfTurn ? <span className="turn-alert-chip">Your turn</span> : null}
                <span>{game.phase === "lobby" ? lobbyReadiness : turnCoach?.detail}</span>
                {chatEnabled && (chatLiveVoiceEnabled || liveVoiceJoined) ? (
                  <button
                    type="button"
                    className="mobile-talk-control"
                    aria-haspopup="dialog"
                    aria-label={`Open table talk. ${LIVE_VOICE_STATUS_COPY[liveVoiceSnapshot.status]}.`}
                    onClick={(event) => openVoiceSheet(event.currentTarget)}
                  >
                    Talk
                    {chatUnread ? (
                      <span className="chat-unread" aria-label={`${chatUnread} unread chat messages`}>
                        {chatUnread}
                      </span>
                    ) : null}
                  </button>
                ) : null}
              </div>
            </div>

            {game.legalActions.canClaimHost ? (
              <section className="host-continuity" aria-labelledby="host-continuity-title">
                <span className="sr-only" role="status">
                  Host recovery is available. You can keep this table going.
                </span>
                <div>
                  <span className="eyebrow">Host unavailable</span>
                  <h2 id="host-continuity-title">Keep this table going</h2>
                  <p>
                    The server&apos;s reconnect grace period has ended. Become host without
                    removing anyone or changing players, cards, the turn, or this series.
                  </p>
                  {hostClaimSaved ? (
                    <small>Connection interrupted. Retry the saved action above; the same claim will be used safely.</small>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="primary-button acid"
                  disabled={actionPending || hostClaimPending}
                  onClick={() => void claimHost()}
                >
                  {hostClaimPending ? "Taking over…" : hostClaimSaved ? "Claim saved" : "Keep table going"}
                </button>
              </section>
            ) : null}

            {game.phase === "lobby" && game.isHost && listing ? (
              <section className={`public-listing-control is-${listing.state}`} aria-labelledby="public-listing-title">
                <div>
                  <span className="eyebrow">Open-table listing</span>
                  <h2 id="public-listing-title">
                    {listing.state === "listed"
                      ? "This table is open"
                      : listing.state === "suppressed"
                        ? "Listing temporarily paused"
                        : "Private by default"}
                  </h2>
                  <p>
                    {listing.state === "listed"
                      ? `Anonymous players can find ${listing.pace === "quick" ? "a quick" : "a casual"} table. Public cards show only seats, pace, rules, and broad wait age.`
                      : listing.state === "suppressed"
                        ? "The server has hidden this table while host presence recovers. Seated players are unchanged."
                        : "Publish only when you want strangers to join. Your room alias is never shown on the public card."}
                  </p>
                  {listing.state === "private" && listingUnavailableReason(listing.reason) ? (
                    <span className="listing-reason">{listingUnavailableReason(listing.reason)}</span>
                  ) : null}
                </div>
                <div className="public-listing-control__action">
                  {listing.state !== "private" ? (
                    <span className="listing-state-chip">{listing.state === "listed" ? "Listed" : "Paused"}</span>
                  ) : null}
                  <button
                    className={listing.state === "private" ? "primary-button acid" : "secondary-button"}
                    disabled={actionPending || (listing.state === "private" && !listing.canPublish)}
                    onClick={(event) => openListingDialog(
                      listing.state === "private" ? "publish" : "unpublish",
                      event.currentTarget,
                    )}
                  >
                    {listing.state === "private" ? "List publicly" : "Make private"}
                  </button>
                </div>
              </section>
            ) : null}

            {game.phase === "playing" && hasTurnActions ? (
              <div className="turn-actions is-urgent" aria-label="Available actions">
                {game.legalActions.canChooseRouletteColor ? (
                  <div className="choice-row" role="group" aria-label="Choose Color Roulette color">
                    <strong>Choose a color to reveal</strong>
                    {COLORS.map((color) => (
                      <button
                        key={color}
                        className={`color-choice card-${color}`}
                        disabled={actionPending}
                        onClick={() => void sendCommand({ type: "choose_roulette_color", color })}
                      >
                        {color}
                      </button>
                    ))}
                  </div>
                ) : null}
                {game.legalActions.canAcceptPenalty ? (
                  <button className="primary-button danger" disabled={actionPending} onClick={() => void sendCommand({ type: "accept_penalty" })}>
                    Take {game.pendingDraw?.total} cards
                  </button>
                ) : null}
                {game.legalActions.canDrawUntilPlayable ? (
                  <button className="primary-button" disabled={actionPending} onClick={() => void sendCommand({ type: "draw_until_playable" })}>
                    Your turn — draw until playable
                  </button>
                ) : null}
                {game.legalActions.canDeclareUno ? (
                  <button className="primary-button acid" disabled={actionPending} onClick={() => void sendCommand({ type: "declare_uno" })}>
                    Call UNO now
                  </button>
                ) : null}
                {game.legalActions.catchablePlayerIds.map((playerId) => {
                  const player = game.players.find((candidate) => candidate.playerId === playerId);
                  return (
                    <button key={playerId} className="primary-button danger" disabled={actionPending} onClick={() => void sendCommand({ type: "catch_uno", offenderPlayerId: playerId })}>
                      Catch {player?.displayName ?? "player"}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {game.phase === "complete" ? (
              <section className="result-sheet" aria-labelledby="result-title">
                <span className="eyebrow">{roundLabel(game.series.roundNumber)} complete</span>
                <h2 id="result-title">{game.winner?.displayName ?? "The table"} wins.</h2>
                <p>
                  {game.winner?.reason === "empty_hand"
                    ? "They shed their final card before the table could answer."
                    : "They survived as the last active player under the Mercy rule."}
                </p>
                <div className="result-dashboard">
                  <section className="result-round-panel" aria-labelledby="round-finish-title">
                    <span className="eyebrow">Round finish</span>
                    <h3 id="round-finish-title">This round</h3>
                    <div className="result-standings" aria-label={`${roundLabel(game.series.roundNumber)} final player standings`}>
                      {game.players.map((player) => (
                        <div key={player.playerId} className={player.playerId === game.winner?.playerId ? "is-winner" : ""}>
                          <strong>{player.displayName}{player.isSelf ? " (you)" : ""}</strong>
                          <span>
                            {player.playerId === game.winner?.playerId
                              ? "Winner"
                              : player.status === "eliminated"
                                ? "Mercy knockout"
                                : player.status === "left"
                                  ? "Left table"
                                  : `${player.cardCount} cards remaining`}
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="result-series" aria-labelledby="series-score-title">
                    <div className="result-section-heading">
                      <div>
                        <span className="eyebrow">Series to date</span>
                        <h3 id="series-score-title">Series score</h3>
                      </div>
                      <span>{game.series.completedRounds} {game.series.completedRounds === 1 ? "round" : "rounds"}</span>
                    </div>
                    <ol className="series-score-list">
                      {rankedSeriesScores.map(({ rank, score }, index) => {
                        const player = game.players.find((candidate) => candidate.playerId === score.playerId);
                        return (
                          <li key={score.playerId} className={index === 0 && score.wins > 0 ? "is-leading" : ""}>
                            <span className="series-rank" aria-label={`Rank ${rank}`}>{String(rank).padStart(2, "0")}</span>
                            <strong>{score.displayName}{player?.isSelf ? " (you)" : ""}</strong>
                            <span>{seriesWinLabel(score.wins)}</span>
                          </li>
                        );
                      })}
                    </ol>
                  </section>
                </div>

                {game.series.recentWinners.length ? (
                  <section className="recent-winners" aria-labelledby="recent-winners-title">
                    <div className="result-section-heading">
                      <div>
                        <span className="eyebrow">Last five at most</span>
                        <h3 id="recent-winners-title">Recent winners</h3>
                      </div>
                    </div>
                    <ol>
                      {game.series.recentWinners.map((winner) => (
                        <li key={`${winner.roundNumber}-${winner.completedAt}`}>
                          <strong>{roundLabel(winner.roundNumber)} — {winner.displayName}</strong>
                          <span>{winnerReasonLabel(winner.reason)}</span>
                        </li>
                      ))}
                    </ol>
                  </section>
                ) : null}
                <div className="result-actions">
                  {canRematch ? (
                    <button className="primary-button acid" disabled={actionPending} onClick={() => void sendCommand({ type: "rematch" })}>
                      Play round {nextRoundNumber}
                    </button>
                  ) : game.isHost ? null : (
                    <span className="waiting-copy">Waiting for the host to start round {nextRoundNumber}.</span>
                  )}
                  {canRematch ? <span className="continuity-copy">Keeps this table, players, and series score.</span> : null}
                  <button className="secondary-button" disabled={actionPending} onClick={() => void leaveTable()}>Leave table and go back</button>
                  <button className="secondary-button" disabled={actionPending} onClick={() => void createLobby()}>Create a new table</button>
                </div>
              </section>
            ) : (
              <div
                className={`table-vfx ${playedCardFxRevision?.gameId === game.gameId && playedCardFxRevision.revision === game.revision ? "has-played-card-pulse" : ""}`.trim()}
              >
                <GameTableCanvas game={game} />
              </div>
            )}

            {game.phase === "lobby" ? (
              <div className="lobby-actions">
                <button
                  className="primary-button acid invite-button"
                  disabled={actionPending}
                  onClick={() => void shareInvite(true)}
                >
                  Invite players
                </button>
                <button
                  className={self?.ready ? "secondary-button" : "primary-button"}
                  disabled={actionPending}
                  onClick={() => void sendCommand({ type: "set_ready", ready: !self?.ready })}
                >
                  {self?.ready ? "Mark not ready" : "I’m ready"}
                </button>
                {game.isHost ? (
                  <button
                    className="primary-button acid"
                    disabled={actionPending || !game.legalActions.canStart}
                    onClick={() => void sendCommand({ type: "start_game" })}
                  >
                    Start game
                  </button>
                ) : null}
                <span className="waiting-copy">{lobbyReadiness}</span>
              </div>
            ) : null}

            {game.phase === "playing" ? (
              <div className="hand-section">
                <div className="hand-heading">
                  <div>
                    <span className="eyebrow">Your hand</span>
                    <strong>{game.hand.length} cards</strong>
                  </div>
                  <span>{game.currentPlayerId === self?.playerId ? "Select a highlighted card" : "Private to you"}</span>
                </div>
                <div className="card-hand" aria-label="Your cards">
                  {game.hand.map((card) => {
                    const playable = game.legalActions.playableCardIds.includes(card.id);
                    return (
                      <CardFace
                        key={card.id}
                        card={card}
                        variant="hand"
                        interaction={{
                          kind: "play",
                          playable,
                          pending: actionPending,
                          onActivate: selectCard,
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>

          <aside className="game-sidebar">
            <div className="room-block">
              <span className="eyebrow">Table code</span>
              <button
                className="room-code"
                onClick={() => void copyLobbyCode()}
                aria-label={`Copy table code ${game.joinCode}`}
              >
                {game.joinCode}
              </button>
              <span className="table-revision">{tableRevisionLabel(game.revision)}</span>
              {game.phase === "lobby" ? (
                <button className="text-button room-share" disabled={actionPending} onClick={() => void shareInvite(true)}>
                  Share invite
                </button>
              ) : null}
              <span className="share-feedback" aria-live="polite">{shareFeedback}</span>
            </div>

            <button
              className="sidebar-toggle text-button"
              aria-expanded={sidebarDetailsOpen}
              onClick={() => setSidebarDetailsOpen((open) => !open)}
            >
              <span>{chatEnabled ? "Players, chat & activity" : "Players & activity"}</span>
              {chatEnabled && chatUnread ? (
                <span className="chat-unread" aria-label={`${chatUnread} unread chat messages`}>
                  {chatUnread}
                </span>
              ) : null}
            </button>
            <div className={`sidebar-details-panel ${sidebarDetailsOpen ? "is-open" : ""}`}>
              <div className="players-list" aria-label="Players">
                {game.players.map((player) => {
                  const playerPresence = presence?.players.find((entry) => entry.playerId === player.playerId);
                  return (
                    <div
                      className={`player-row ${player.playerId === game.currentPlayerId ? "is-current" : ""}`}
                      key={player.playerId}
                      aria-current={player.playerId === game.currentPlayerId ? "true" : undefined}
                    >
                      <span className="seat-number">{String(player.seat + 1).padStart(2, "0")}</span>
                      <span className="player-copy">
                        <strong>{player.displayName}{player.isSelf ? " (you)" : ""}</strong>
                        <small>{player.status === "active" ? `${player.cardCount} cards` : player.status}</small>
                        {playerPresence && player.status === "active" ? (
                          <span className={`presence-chip presence-${playerPresence.status}`}>
                            {presenceLabel(playerPresence.status)}
                          </span>
                        ) : null}
                      </span>
                      <span className="player-row-actions">
                        <span className={`ready-mark ${player.ready ? "is-ready" : ""}`}>
                          {game.phase === "lobby" ? (player.ready ? "READY" : "WAIT") : player.status === "active" ? "IN" : "OUT"}
                        </span>
                        {game.isHost && !player.isSelf && player.status === "active" && playerPresence?.removable ? (
                          <button
                            className="player-remove"
                            disabled={actionPending}
                            onClick={(event) => requestInactiveRemoval(player.playerId, event.currentTarget)}
                            aria-label={`Remove inactive player ${player.displayName}`}
                          >
                            Remove
                          </button>
                        ) : null}
                      </span>
                    </div>
                  );
                })}
              </div>
              {chatEnabled ? (
                <div className="sidebar-communication">
                  {chatLiveVoiceEnabled || liveVoiceJoined ? (
                    <section
                      className="voice-strip"
                      aria-label="Live table voice"
                      data-status={liveVoiceSnapshot.status}
                    >
                      <div>
                        <span className="eyebrow">Live voice</span>
                        <strong>{LIVE_VOICE_STATUS_COPY[liveVoiceSnapshot.status]}</strong>
                        {liveVoiceJoined ? (
                          <small>
                            {liveVoiceSnapshot.participants.length} connected · voice is not recorded
                          </small>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        disabled={liveVoiceBusy}
                        aria-haspopup="dialog"
                        onClick={(event) => openVoiceSheet(event.currentTarget)}
                      >
                        {liveVoiceJoined ? "Controls" : "Details"}
                      </button>
                    </section>
                  ) : null}
                  <div
                    className="sidebar-tabs"
                    role="tablist"
                    aria-label="Table communication"
                    aria-orientation="horizontal"
                  >
                    <button
                      id="chat-tab"
                      type="button"
                      role="tab"
                      aria-controls="chat-panel"
                      aria-selected={sidebarTab === "chat"}
                      tabIndex={sidebarTab === "chat" ? 0 : -1}
                      onClick={() => selectSidebarTab("chat")}
                      onKeyDown={(event) => {
                        if (event.key !== "ArrowRight" && event.key !== "End") return;
                        event.preventDefault();
                        selectSidebarTab("activity");
                        window.requestAnimationFrame(() =>
                          document.getElementById("activity-tab")?.focus(),
                        );
                      }}
                    >
                      Chat
                      {chatUnread ? (
                        <span className="chat-unread" aria-label={`${chatUnread} unread`}>
                          {chatUnread}
                        </span>
                      ) : null}
                    </button>
                    <button
                      id="activity-tab"
                      type="button"
                      role="tab"
                      aria-controls="activity-panel"
                      aria-selected={sidebarTab === "activity"}
                      tabIndex={sidebarTab === "activity" ? 0 : -1}
                      onClick={() => selectSidebarTab("activity")}
                      onKeyDown={(event) => {
                        if (event.key !== "ArrowLeft" && event.key !== "Home") return;
                        event.preventDefault();
                        selectSidebarTab("chat");
                        window.requestAnimationFrame(() =>
                          document.getElementById("chat-tab")?.focus(),
                        );
                      }}
                    >
                      Activity
                    </button>
                  </div>

                  <section
                    id="chat-panel"
                    className="chat-panel"
                    role="tabpanel"
                    aria-labelledby="chat-tab"
                    hidden={sidebarTab !== "chat"}
                  >
                    <div className="chat-toolbar">
                      <span className="eyebrow">Table chat</span>
                      <button
                        type="button"
                        className="chat-announcement-toggle"
                        role="switch"
                        aria-checked={chatAnnouncements}
                        aria-label="Announce new chat messages"
                        onClick={toggleChatAnnouncements}
                      >
                        Announce {chatAnnouncements ? "on" : "off"}
                      </button>
                    </div>
                    <div
                      ref={chatLogRef}
                      className="chat-feed"
                      role="log"
                      aria-label="Table chat"
                      aria-live={chatAnnouncements ? "polite" : "off"}
                      aria-relevant="additions"
                    >
                      {visibleChatMessages.length ? (
                        visibleChatMessages.map((message) => {
                          const presentation = message.kind === "text"
                            ? null
                            : chatContentPresentation(message.kind, message.contentId);
                          const isSelfMessage = message.senderPlayerId === self?.playerId;
                          if (message.kind !== "text" && !presentation) return null;
                          return (
                            <article
                              className={`chat-message ${isSelfMessage ? "is-self" : ""}`}
                              key={message.id}
                              data-message-id={message.id}
                            >
                              <div className="chat-message__meta">
                                <strong>
                                  {message.senderDisplayName}{isSelfMessage ? " (you)" : ""}
                                </strong>
                                <time dateTime={new Date(message.createdAt).toISOString()}>
                                  {formatChatTime(message.createdAt)}
                                </time>
                              </div>
                              <div className="chat-message__content">
                                {message.kind === "text" ? (
                                  <span className="chat-message__text">{message.body}</span>
                                ) : (
                                  <>
                                    {presentation?.icon ? (
                                      <span className="chat-message__icon" aria-hidden="true">
                                        {presentation.icon}
                                      </span>
                                    ) : null}
                                    <span>{presentation?.label}</span>
                                  </>
                                )}
                              </div>
                              {!isSelfMessage ? (
                                <details className="chat-message-actions">
                                  <summary aria-label={`Actions for message from ${message.senderDisplayName}`}>
                                    •••
                                  </summary>
                                  <div>
                                    <button
                                      type="button"
                                      onClick={(event) => openChatDialog("mute", message, event.currentTarget)}
                                    >
                                      Mute
                                    </button>
                                    <button
                                      type="button"
                                      onClick={(event) => openChatDialog("block", message, event.currentTarget)}
                                    >
                                      Block
                                    </button>
                                    <button
                                      type="button"
                                      onClick={(event) => openChatDialog("report", message, event.currentTarget)}
                                    >
                                      Report
                                    </button>
                                  </div>
                                </details>
                              ) : null}
                            </article>
                          );
                        })
                      ) : (
                        <p className="chat-empty">
                          {chatFreeTextEnabled
                            ? "No messages yet. Say hello to your private table."
                            : "No messages yet. Use a quick phrase or reaction—free text stays off."}
                        </p>
                      )}
                    </div>

                    {chatError ? <p className="chat-feedback is-error" role="alert">{chatError}</p> : null}
                    {chatStatus ? <p className="chat-feedback" role="status">{chatStatus}</p> : null}

                    {chatFreeTextEnabled ? (
                      <form className="chat-text-composer" onSubmit={sendFreeTextChat}>
                        <p id="chat-text-privacy" className="chat-text-privacy">
                          Invite-only table chat. Plain text only—no links or contact details.
                          Messages are visible only to current table members and disappear after
                          24 hours. Mute, Block, and Report stay available.
                        </p>
                        <label htmlFor="chat-text-draft">Message your table</label>
                        <textarea
                          id="chat-text-draft"
                          rows={3}
                          value={chatDraft}
                          disabled={chatSending}
                          autoComplete="off"
                          aria-invalid={Boolean(chatDraftError) || chatDraftGraphemes > CHAT_TEXT_MAX_GRAPHEMES}
                          aria-describedby="chat-text-privacy chat-text-count chat-text-error"
                          onChange={(event) => {
                            setChatDraft(event.target.value);
                            setChatDraftError(null);
                          }}
                          onKeyDown={(event) => {
                            if (
                              event.key !== "Enter" ||
                              event.shiftKey ||
                              event.nativeEvent.isComposing
                            ) return;
                            event.preventDefault();
                            event.currentTarget.form?.requestSubmit();
                          }}
                        />
                        <div className="chat-text-composer__meta">
                          <span
                            id="chat-text-count"
                            className={chatDraftGraphemes > CHAT_TEXT_MAX_GRAPHEMES ? "is-over" : ""}
                          >
                            {chatDraftGraphemes} / {CHAT_TEXT_MAX_GRAPHEMES}
                          </span>
                          <button
                            type="submit"
                            disabled={
                              chatSending ||
                              chatCoolingDown ||
                              !preparedChatDraft ||
                              chatDraftGraphemes > CHAT_TEXT_MAX_GRAPHEMES
                            }
                          >
                            {chatSending ? "Sending…" : chatCoolingDown ? "Wait…" : "Send"}
                          </button>
                        </div>
                        <p id="chat-text-error" className="chat-draft-error" aria-live="polite">
                          {chatDraftError}
                        </p>
                      </form>
                    ) : null}

                    {chatFreeTextEnabled ? (
                      <details className="chat-quick-controls">
                        <summary>Quick phrases &amp; reactions</summary>
                        <div className="chat-composer" aria-label="Send a quick chat message">
                          <span className="eyebrow">Quick phrases</span>
                          <div className="chat-phrase-grid">
                            {CHAT_PHRASES.map((phrase) => (
                              <button
                                key={phrase.id}
                                type="button"
                                disabled={chatSending || chatCoolingDown}
                                aria-label={`Send “${phrase.label}”`}
                                onClick={() => void sendCuratedChat("phrase", phrase.id)}
                              >
                                {phrase.label}
                              </button>
                            ))}
                          </div>
                          <span className="eyebrow">Reactions</span>
                          <div className="chat-reaction-grid">
                            {CHAT_REACTIONS.map((reaction) => (
                              <button
                                key={reaction.id}
                                type="button"
                                disabled={chatSending || chatCoolingDown}
                                aria-label={`Send ${reaction.label}`}
                                title={reaction.label}
                                onClick={() => void sendCuratedChat("reaction", reaction.id)}
                              >
                                <span aria-hidden="true">{reaction.icon}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      </details>
                    ) : (
                      <div className="chat-composer" aria-label="Send a curated chat message">
                        <span className="eyebrow">Quick phrases</span>
                        <div className="chat-phrase-grid">
                          {CHAT_PHRASES.map((phrase) => (
                            <button
                              key={phrase.id}
                              type="button"
                              disabled={chatSending || chatCoolingDown}
                              aria-label={`Send “${phrase.label}”`}
                              onClick={() => void sendCuratedChat("phrase", phrase.id)}
                            >
                              {phrase.label}
                            </button>
                          ))}
                        </div>
                        <span className="eyebrow">Reactions</span>
                        <div className="chat-reaction-grid">
                          {CHAT_REACTIONS.map((reaction) => (
                            <button
                              key={reaction.id}
                              type="button"
                              disabled={chatSending || chatCoolingDown}
                              aria-label={`Send ${reaction.label}`}
                              title={reaction.label}
                              onClick={() => void sendCuratedChat("reaction", reaction.id)}
                            >
                              <span aria-hidden="true">{reaction.icon}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {Object.keys(mutedChatPlayers).length || Object.keys(blockedChatPlayers).length ? (
                      <details className="chat-safety-controls">
                        <summary>Muted &amp; blocked players</summary>
                        {Object.entries(mutedChatPlayers).map(([playerId, displayName]) => (
                          <div key={`muted-${playerId}`}>
                            <span>{displayName} · muted</span>
                            <button
                              type="button"
                              disabled={chatModerationBusy}
                              onClick={() => void changeChatRestriction("mute", playerId, displayName, false)}
                            >
                              Unmute
                            </button>
                          </div>
                        ))}
                        {Object.entries(blockedChatPlayers).map(([playerId, displayName]) => (
                          <div key={`blocked-${playerId}`}>
                            <span>{displayName} · blocked</span>
                            <button
                              type="button"
                              disabled={chatModerationBusy}
                              onClick={() => void changeChatRestriction("block", playerId, displayName, false)}
                            >
                              Unblock
                            </button>
                          </div>
                        ))}
                      </details>
                    ) : null}
                  </section>

                  <div
                    id="activity-panel"
                    className="event-log"
                    role="tabpanel"
                    aria-labelledby="activity-tab"
                    hidden={sidebarTab !== "activity"}
                  >
                    <span className="eyebrow">Recent events</span>
                    <div
                      role="log"
                      aria-label="Recent game events"
                      aria-live="polite"
                      aria-relevant="additions"
                    >
                      {events.length ? events.map((event, index) => (
                        <p key={`${event.type}-${index}`}>{event.message}</p>
                      )) : <p>New table actions will appear here.</p>}
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  className="event-log"
                  role="log"
                  aria-label="Recent game events"
                  aria-live="polite"
                  aria-relevant="additions"
                >
                  <span className="eyebrow">Recent events</span>
                  {events.length ? events.map((event, index) => (
                    <p key={`${event.type}-${index}`}>{event.message}</p>
                  )) : <p>New table actions will appear here.</p>}
                </div>
              )}
            </div>
            <button
              className="secondary-button leave-button"
              disabled={actionPending}
              onClick={() => void leaveTable()}
            >
              {game.phase === "complete" ? "Leave table and go back" : "Leave table"}
            </button>
            <ReleaseIdentity className="release-identity--table" />
          </aside>
          </section>
        )}
      </div>

      {inviteDialogOpen || publicJoinIntent || listingDialogAction || guideTopic || removeTarget ? (
        <div
          ref={utilityDialogRef}
          className="choice-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby={
            inviteDialogOpen
              ? "invite-dialog-title"
              : publicJoinIntent
                ? "public-join-title"
                : listingDialogAction
                  ? "public-listing-dialog-title"
              : removeTarget
                  ? "remove-player-title"
                  : "game-guide-title"
          }
          tabIndex={-1}
        >
          {inviteDialogOpen ? (
            <div className="choice-panel invite-panel">
              <span className="eyebrow">You’re invited</span>
              <h2 id="invite-dialog-title">Join table {inviteCode}?</h2>
              <p className="dialog-copy">
                Choose a room alias, then join the lobby. Your account name is never filled in.
              </p>
              <label className="input-label dialog-input" htmlFor="invite-player-name">
                <span>Room alias</span>
                <input
                  id="invite-player-name"
                  value={joinAlias}
                  maxLength={ROOM_ALIAS_MAX_LENGTH}
                  onChange={(event) => {
                    setJoinAlias(event.target.value);
                    if (inviteError) setInviteError(null);
                  }}
                  autoComplete="off"
                  placeholder="Choose a table name"
                />
              </label>
              <p className="dialog-privacy-note">Only the alias you enter will be visible to seated players.</p>
              {inviteError ? <p className="field-error invite-error" role="alert">{inviteError}</p> : null}
              <div className="dialog-actions">
                <button className="secondary-button" disabled={busy} onClick={dismissInvite}>Use another code</button>
                <button className="primary-button acid" disabled={busy || !joinAlias.trim()} onClick={() => void confirmInvite()}>
                  {busy ? "Joining…" : "Join this table"}
                </button>
              </div>
            </div>
          ) : publicJoinIntent ? (
            <form className="choice-panel public-join-panel" onSubmit={confirmPublicJoin}>
              <span className="eyebrow">
                {publicJoinIntent.kind === "quick" ? "Quick join" : "Open table"}
              </span>
              <h2 id="public-join-title">
                {publicJoinIntent.kind === "quick"
                  ? "Find your next table?"
                  : "Join this open table?"}
              </h2>
              <p className="dialog-copy">
                Confirm a room alias. The server will check the table again before it takes your seat.
              </p>
              {publicJoinRoom ? (
                <div className="public-join-summary" aria-label="Selected open table">
                  <strong>{publicJoinRoom.occupancy}/{publicJoinRoom.capacity} players</strong>
                  <span>{publicJoinRoom.pace === "quick" ? "Quick pace" : "Casual pace"}</span>
                  <span>Merciless baseline</span>
                  <span>{waitingAgeLabel(publicJoinRoom.waitingAge)}</span>
                </div>
              ) : null}
              <label className="input-label dialog-input" htmlFor="public-room-alias">
                <span>Room alias</span>
                <input
                  ref={publicAliasInputRef}
                  id="public-room-alias"
                  value={publicAlias}
                  maxLength={ROOM_ALIAS_MAX_LENGTH}
                  autoComplete="off"
                  placeholder="Choose a table name"
                  aria-required="true"
                  aria-invalid={Boolean(publicJoinError)}
                  aria-describedby="public-room-alias-note"
                  onChange={(event) => {
                    setPublicAlias(event.target.value);
                    if (publicJoinError) setPublicJoinError(null);
                  }}
                />
              </label>
              <p id="public-room-alias-note" className="dialog-privacy-note">
                Your account name is not filled in. Only the alias you enter will appear to seated players.
              </p>
              {publicJoinError ? <p className="field-error invite-error" role="alert">{publicJoinError}</p> : null}
              <div className="dialog-actions">
                <button type="button" className="secondary-button" disabled={busy} onClick={closePublicJoin}>
                  Back to open tables
                </button>
                <button type="submit" className="primary-button acid" disabled={busy || !publicAlias.trim()}>
                  {busy ? "Checking table…" : "Confirm alias & join"}
                </button>
              </div>
            </form>
          ) : listingDialogAction ? (
            <form className="choice-panel public-listing-panel" onSubmit={confirmListingChange}>
              <span className="eyebrow">Host control</span>
              <h2 id="public-listing-dialog-title">
                {listingDialogAction === "publish"
                  ? "List this table publicly?"
                  : "Make this table private?"}
              </h2>
              {listingDialogAction === "publish" ? (
                <>
                  <p className="dialog-copy">
                    Before sign-in, strangers see only 1 of 6 players, your chosen pace, the rules profile, and a broad waiting age.
                  </p>
                  <label className="input-label dialog-input" htmlFor="public-host-alias">
                    <span>Your room alias</span>
                    <input
                      ref={publicAliasInputRef}
                      id="public-host-alias"
                      value={listingAlias}
                      maxLength={ROOM_ALIAS_MAX_LENGTH}
                      autoComplete="off"
                      placeholder="Choose a table name"
                      aria-required="true"
                      aria-invalid={Boolean(listingError)}
                      aria-describedby="public-host-alias-note"
                      onChange={(event) => {
                        setListingAlias(event.target.value);
                        if (listingError) setListingError(null);
                      }}
                    />
                  </label>
                  <p id="public-host-alias-note" className="dialog-privacy-note">
                    This starts empty and never falls back to your account name. It becomes visible only to players after they join.
                  </p>
                  <fieldset className="pace-fieldset">
                    <legend>Table pace</legend>
                    <div className="pace-options">
                      {PUBLIC_PACES.map((pace) => (
                        <label
                          key={pace}
                          htmlFor={`public-table-pace-${pace}`}
                          aria-label={`${pace === "quick" ? "Quick" : "Casual"} table pace`}
                          className={listingPace === pace ? "is-selected" : ""}
                        >
                          <input
                            id={`public-table-pace-${pace}`}
                            type="radio"
                            name="public-table-pace"
                            value={pace}
                            checked={listingPace === pace}
                            onChange={() => setListingPace(pace)}
                          />
                          <span>
                            <strong>{pace === "quick" ? "Quick" : "Casual"}</strong>
                            <small>{pace === "quick" ? "Ready to start soon" : "Room for a relaxed setup"}</small>
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </>
              ) : (
                <p className="dialog-copy">
                  The table disappears from open discovery immediately. Everyone already seated stays in the lobby, and private invite links keep working.
                </p>
              )}
              {listingError ? <p className="field-error invite-error" role="alert">{listingError}</p> : null}
              <div className="dialog-actions">
                <button type="button" className="secondary-button" disabled={busy} onClick={closeListingDialog}>Cancel</button>
                <button
                  type="submit"
                  className={listingDialogAction === "publish" ? "primary-button acid" : "primary-button"}
                  disabled={busy || (listingDialogAction === "publish" && !listingAlias.trim())}
                >
                  {busy
                    ? "Saving…"
                    : listingDialogAction === "publish"
                      ? "Confirm & list publicly"
                      : "Confirm & make private"}
                </button>
              </div>
            </form>
          ) : removeTarget ? (
            <div className="choice-panel">
              <span className="eyebrow">Host control</span>
              <h2 id="remove-player-title">Remove {removeTarget.displayName}?</h2>
              <p className="dialog-copy">
                They have been offline long enough to remove. Their cards leave active play and the server repairs the turn if needed.
              </p>
              <div className="dialog-actions">
                <button className="secondary-button" disabled={busy} onClick={closeInactiveRemoval}>Keep player</button>
                <button className="primary-button danger" disabled={actionPending} onClick={() => void confirmInactiveRemoval()}>
                  Remove inactive player
                </button>
              </div>
            </div>
          ) : guideTopic ? (
            <div className="choice-panel guide-panel">
              <span className="eyebrow">Merciless baseline / v1</span>
              <h2 id="game-guide-title">Rules &amp; action guide</h2>
              <div className="guide-tabs" role="tablist" aria-label="Game guide sections">
                <button
                  role="tab"
                  aria-selected={guideTopic === "rules"}
                  className={guideTopic === "rules" ? "is-selected" : ""}
                  onClick={() => setGuideTopic("rules")}
                >
                  Quick rules
                </button>
                <button
                  role="tab"
                  aria-selected={guideTopic === "actions"}
                  className={guideTopic === "actions" ? "is-selected" : ""}
                  onClick={() => setGuideTopic("actions")}
                >
                  Action cards
                </button>
              </div>
              {guideTopic === "rules" ? (
                <div className="guide-content" role="tabpanel">
                  <ol>
                    <li><strong>Match one card.</strong><span>Play the active color, number, symbol, or a Wild. If a legal card exists, you must play.</span></li>
                    <li><strong>Draw to a match.</strong><span>No match means drawing until the first playable card appears, then playing that exact card.</span></li>
                    <li><strong>Stack equal or higher.</strong><span>During a draw chain, stack a draw card worth at least the last one or take the whole penalty.</span></li>
                    <li><strong>Move hands with 0 and 7.</strong><span>A 0 passes all active hands; a 7 forces a swap with one active player.</span></li>
                    <li><strong>Call UNO. Survive Mercy.</strong><span>Call UNO at one card. Reaching 25 cards knocks you out.</span></li>
                  </ol>
                </div>
              ) : (
                <div className="guide-content action-guide-list" role="tabpanel">
                  {ACTION_GUIDE.map(([title, description]) => (
                    <article key={title}><strong>{title}</strong><span>{description}</span></article>
                  ))}
                </div>
              )}
              <div className="dialog-actions">
                <button className="primary-button" onClick={closeGuide}>Back to the table</button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {soundDialogOpen ? (
        <div
          ref={soundDialogRef}
          className="choice-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sound-settings-title"
          aria-describedby="sound-settings-intro sound-settings-disclosure"
          tabIndex={-1}
        >
          <div className="choice-panel sound-panel">
            <span className="eyebrow">Table audio</span>
            <h2 id="sound-settings-title">Sound settings</h2>
            <p id="sound-settings-intro" className="dialog-copy">
              Sound never starts automatically. Enable it with a tap or click, then choose
              how lively the table should feel.
            </p>

            <div className="sound-settings">
              <div className="sound-setting-row">
                <span className="sound-setting-copy">
                  <strong>Game sound</strong>
                  <span>
                    {soundControlState === "on"
                      ? "Ready for card effects and turn chimes in this session."
                      : soundControlState === "ready"
                        ? "Your preference is saved. Tap to enable audio in this browser session."
                        : "Muted. No game sounds or spoken callouts will play."}
                  </span>
                </span>
                <span className="sound-master-actions">
                  <button
                    type="button"
                    className="sound-toggle"
                    aria-pressed={soundControlState === "on"}
                    disabled={!soundAvailable}
                    onClick={() => void changeSoundEnabled()}
                  >
                    {soundControlState === "on"
                      ? "Mute"
                      : soundControlState === "ready"
                        ? "Enable now"
                        : "Enable sound"}
                  </button>
                  {soundControlState === "ready" ? (
                    <button
                      type="button"
                      className="text-button sound-turn-off"
                      onClick={() => void turnSoundOff()}
                    >
                      Turn sound off
                    </button>
                  ) : null}
                </span>
              </div>

              <div className="sound-setting-row">
                <span className="sound-setting-copy">
                  <strong>Volume</strong>
                  <span>Controls effects, turn chimes, and spoken callouts.</span>
                </span>
                <label className="sound-volume" htmlFor="sound-volume">
                  <span className="sr-only">Game sound volume</span>
                  <input
                    id="sound-volume"
                    type="range"
                    min="0"
                    max="100"
                    step="5"
                    value={soundSettings.volume}
                    disabled={!soundAvailable}
                    onChange={(event) => changeSoundVolume(Number(event.target.value))}
                  />
                  <output htmlFor="sound-volume">{soundSettings.volume}%</output>
                </label>
              </div>

              <div className="sound-setting-row">
                <span className="sound-setting-copy">
                  <strong>Spoken card callouts</strong>
                  <span>Calls the public card color and value after a visible play.</span>
                </span>
                <button
                  type="button"
                  className="sound-toggle"
                  role="switch"
                  aria-checked={soundSettings.spokenCallouts}
                  disabled={!soundCapabilities.speech}
                  onClick={changeSpokenCallouts}
                >
                  {soundSettings.spokenCallouts ? "Callouts on" : "Callouts off"}
                </button>
              </div>
            </div>

            <p id="sound-settings-disclosure" className="sound-disclosure">
              Spoken callouts use your device&apos;s synthesized voice; the voice varies by
              browser and device. Open Shed sends no microphone or voice recording to the
              game server. Turn chimes may sound while this table is in the background.
              Card sounds and spoken callouts play only while you&apos;re viewing it.
            </p>
            <div className="sound-feedback" aria-live="polite">
              {!soundAvailable
                ? "This browser does not provide the audio features this table needs."
                : !soundCapabilities.speech
                  ? "Game sounds are available, but spoken callouts are not supported here."
                  : soundStatus}
            </div>
            <div className="dialog-actions">
              <button type="button" className="secondary-button" onClick={closeSoundDialog}>
                Back to the table
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={!soundAvailable}
                onClick={() => void previewSound()}
              >
                {soundControlState === "off" ? "Enable & preview" : "Preview sound"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {bugReportOpen ? (
        <div
          ref={bugReportDialogRef}
          className="choice-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="bug-report-title"
          aria-describedby="bug-report-privacy-note"
          tabIndex={-1}
        >
          <div className="choice-panel bug-report-panel">
            <span className="eyebrow">Game issue report</span>
            <h2 id="bug-report-title">Tell us what went wrong</h2>
            <p id="bug-report-privacy-note" className="bug-report-privacy-note">
              Do not include personal information, account or player names, table codes,
              game links or IDs, chat messages, screenshots, private cards, or card IDs.
              Describe cards by their visible label, such as Wild Color Roulette.
            </p>

            <fieldset className="bug-report-categories">
              <legend>What kind of issue is this?</legend>
              {BUG_REPORT_CATEGORIES.map((category) => (
                <label key={category.id}>
                  <input
                    type="radio"
                    name="bug-report-category"
                    value={category.id}
                    checked={bugReportCategory === category.id}
                    onChange={() => {
                      setBugReportCategory(category.id);
                      setBugReportError(null);
                    }}
                  />
                  <span>{category.label}</span>
                </label>
              ))}
            </fieldset>

            <label className="bug-report-description" htmlFor="bug-report-description">
              <span>What happened, and what did you expect?</span>
              <textarea
                ref={bugReportDescriptionRef}
                id="bug-report-description"
                value={bugReportDescription}
                minLength={10}
                rows={6}
                required
                aria-invalid={Boolean(bugReportError)}
                aria-describedby="bug-report-description-hint bug-report-feedback"
                placeholder="Example: After I played Wild Color Roulette, both players appeared to be waiting. I expected the other player to choose a color."
                onChange={(event) => {
                  setBugReportDescription(
                    Array.from(event.target.value.normalize("NFKC"))
                      .slice(0, BUG_REPORT_DESCRIPTION_MAX_LENGTH)
                      .join(""),
                  );
                  setBugReportError(null);
                  setBugReportStatus(null);
                }}
              />
              <span id="bug-report-description-hint" className="bug-report-description-meta">
                <span>Use general terms—never paste a link, table code, or identifier.</span>
                <span>{Array.from(bugReportDescription.normalize("NFKC")).length}/{BUG_REPORT_DESCRIPTION_MAX_LENGTH}</span>
              </span>
            </label>

            <details className="bug-report-diagnostics">
              <summary>Safe diagnostics included</summary>
              <p>
                Only app/rules/protocol versions, table revision, connection and turn flags, public
                counts/colors, fixed action IDs, viewport size, and up to three event kinds.
                No names, table/game/card IDs, messages, screenshots, or private hand data.
              </p>
              {bugReportDiagnostics ? (
                <dl>
                  <div><dt>Phase</dt><dd>{bugReportDiagnostics.phase}</dd></div>
                  <div><dt>Table revision</dt><dd>{bugReportDiagnostics.revision ?? "none"}</dd></div>
                  <div><dt>Connection</dt><dd>{bugReportDiagnostics.connection}</dd></div>
                  <div><dt>Current turn is yours</dt><dd>{bugReportDiagnostics.currentTurnIsSelf === null ? "not applicable" : bugReportDiagnostics.currentTurnIsSelf ? "yes" : "no"}</dd></div>
                  <div><dt>Roulette choice</dt><dd>{bugReportDiagnostics.rouletteChoice}</dd></div>
                  <div><dt>Available actions</dt><dd>{bugReportDiagnostics.legalActions.join(", ") || "none"}</dd></div>
                </dl>
              ) : null}
            </details>

            <p className="bug-report-github-note">
              A GitHub issue is public, and your GitHub identity will be visible if you submit.
              Review opens a prefilled draft in a new tab. Nothing is submitted until you
              review it on GitHub and choose Submit new issue.
            </p>
            <p className="bug-report-security-note">
              Security, privacy, sign-in, authentication, or private-hand vulnerabilities
              must not be posted as public issues. Use the repository&apos;s{" "}
              <a
                href="https://github.com/NiyiOke/open-shed-card-engine/security/policy"
                target="_blank"
                rel="noopener noreferrer"
              >
                private security policy <span aria-hidden="true">↗</span>
              </a>
              .
            </p>
            <div id="bug-report-feedback" className="bug-report-feedback" aria-live="polite">
              {bugReportError ? <p className="field-error" role="alert">{bugReportError}</p> : null}
              {bugReportStatus ? <p role="status">{bugReportStatus}</p> : null}
            </div>
            <div className="dialog-actions bug-report-actions">
              <button type="button" className="secondary-button" onClick={closeBugReport}>
                Cancel
              </button>
              <button type="button" className="secondary-button" onClick={() => void copyBugReport()}>
                Copy report
              </button>
              {bugReportIssueLink.href ? (
                <a
                  className="primary-button acid"
                  href={bugReportIssueLink.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => {
                    setBugReportError(null);
                    setBugReportStatus(
                      "Public GitHub draft requested. Nothing has been submitted by Open Shed.",
                    );
                  }}
                >
                  Review public draft on GitHub (opens in new tab)
                </a>
              ) : (
                <button
                  type="button"
                  className="primary-button acid"
                  onClick={() => {
                    setBugReportStatus(null);
                    setBugReportError(
                      bugReportIssueLink.error ?? "Complete the report before opening GitHub.",
                    );
                    bugReportDescriptionRef.current?.focus();
                  }}
                >
                  Review public draft on GitHub (opens in new tab)
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {chatDialog ? (
        <div
          ref={chatDialogRef}
          className="choice-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="chat-moderation-title"
          tabIndex={-1}
        >
          <div className="choice-panel chat-moderation-panel">
            <span className="eyebrow">Chat safety</span>
            <h2 id="chat-moderation-title">
              {chatDialog.action === "mute"
                ? `Mute ${chatDialog.displayName}?`
                : chatDialog.action === "block"
                  ? `Block ${chatDialog.displayName}?`
                  : "Report this message?"}
            </h2>
            <p className="dialog-copy">
              {chatDialog.action === "mute"
                ? "Their table messages will be hidden for you. You can unmute them from chat safety controls."
                : chatDialog.action === "block"
                  ? "Their messages will be hidden, and both of you will be removed from live voice at this table. You can unblock them from chat safety controls."
                  : `Tell us why you’re reporting ${chatDialog.displayName}. Reports never include free-text notes.`}
            </p>
            {chatDialog.action === "report" ? (
              <fieldset className="chat-report-reasons">
                <legend>Reason for report</legend>
                {CHAT_REPORT_REASONS.map((reason) => (
                  <label key={reason.id}>
                    <input
                      type="radio"
                      name="chat-report-reason"
                      value={reason.id}
                      checked={chatReportReason === reason.id}
                      disabled={chatModerationBusy}
                      onChange={() => setChatReportReason(reason.id)}
                    />
                    <span>{reason.label}</span>
                  </label>
                ))}
              </fieldset>
            ) : null}
            {chatError ? <p className="field-error" role="alert">{chatError}</p> : null}
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={chatModerationBusy}
                onClick={closeChatDialog}
              >
                Cancel
              </button>
              <button
                type="button"
                className={chatDialog.action === "mute" ? "primary-button" : "primary-button danger"}
                disabled={chatModerationBusy}
                onClick={() => void confirmChatModeration()}
              >
                {chatModerationBusy
                  ? "Saving…"
                  : chatDialog.action === "mute"
                    ? `Mute ${chatDialog.displayName}`
                    : chatDialog.action === "block"
                      ? `Block ${chatDialog.displayName}`
                      : "Report message"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {voiceSheetOpen ? (
        <div
          ref={voiceSheetRef}
          className="choice-overlay voice-sheet-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="voice-sheet-title"
          aria-describedby="voice-sheet-consent"
          tabIndex={-1}
        >
          <div className="choice-panel voice-sheet">
            <span className="eyebrow">Table talk</span>
            <h2 id="voice-sheet-title">Live voice</h2>
            <p id="voice-sheet-consent" className="dialog-copy voice-consent-copy">
              Live voice is optional and is not recorded by Open Shed. You always join
              muted. Your browser can ask for microphone access only after you explicitly
              choose to turn your microphone on.
            </p>
            <div
              className="voice-state-card"
              data-status={liveVoiceSnapshot.status}
              role="status"
              aria-live="polite"
            >
              <span className="voice-state-dot" aria-hidden="true" />
              <div>
                <strong>{LIVE_VOICE_STATUS_COPY[liveVoiceSnapshot.status]}</strong>
                {liveVoiceSnapshot.status === "unavailable" ? (
                  <p>
                    {liveVoiceSnapshot.error ??
                      "Voice is not available at this table. Private text and quick chat still work normally."}
                  </p>
                ) : liveVoiceSnapshot.status === "prejoin" ||
                  liveVoiceSnapshot.status === "available" ? (
                  <p>Join to listen first. Turning on your microphone is a separate action.</p>
                ) : liveVoiceSnapshot.error ? (
                  <p>{liveVoiceSnapshot.error}</p>
                ) : null}
              </div>
            </div>

            {liveVoiceSnapshot.participants.length ? (
              <div className="voice-participants" aria-label="People in live voice">
                <span className="eyebrow">In voice</span>
                {liveVoiceSnapshot.participants.map((participant) => (
                  <div key={participant.playerId}>
                    <span>
                      <strong>
                        {participant.displayName}{participant.self ? " (you)" : ""}
                      </strong>
                      <small>
                        {participant.speaking
                          ? "Speaking"
                          : participant.microphoneEnabled
                            ? "Microphone on"
                            : "Muted"}
                      </small>
                      {!participant.self ? (
                        <button
                          type="button"
                          className="text-button voice-participant-block"
                          disabled={chatModerationBusy}
                          onClick={(event) =>
                            openVoiceBlockDialog(participant, event.currentTarget)
                          }
                        >
                          Block &amp; disconnect
                        </button>
                      ) : null}
                    </span>
                    <span className={participant.speaking ? "is-speaking" : ""}>
                      {participant.connected ? "Connected" : "Reconnecting"}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            {liveVoiceSnapshot.audioPlaybackBlocked ? (
              <button
                type="button"
                className="secondary-button voice-resume-button"
                onClick={() => void resumeLiveVoiceAudio()}
              >
                Start voice audio
              </button>
            ) : null}

            <p className="voice-safety-note">
              No voice notes are stored. Other people may still record outside Open Shed.
              Blocking a player ends your voice connection; audio is not attached to reports.
            </p>

            <div className="dialog-actions voice-sheet-actions">
              <button type="button" className="secondary-button" onClick={closeVoiceSheet}>
                Close
              </button>
              {(liveVoiceSnapshot.status === "prejoin" ||
                liveVoiceSnapshot.status === "available" ||
                (liveVoiceSnapshot.status === "failed" && !liveVoiceJoined)) ? (
                <button
                  type="button"
                  className="primary-button acid"
                  disabled={liveVoiceBusy}
                  onClick={() => void joinLiveVoice()}
                >
                  Join muted
                </button>
              ) : null}
              {liveVoiceJoined ? (
                <>
                  <button
                    type="button"
                    className={liveVoiceSnapshot.microphoneEnabled ? "primary-button danger" : "primary-button acid"}
                    disabled={liveVoiceBusy || liveVoiceSnapshot.status === "reconnecting"}
                    aria-pressed={liveVoiceSnapshot.microphoneEnabled}
                    onClick={() => void toggleLiveMicrophone()}
                  >
                    {liveVoiceSnapshot.status === "requesting_permission"
                      ? "Requesting permission…"
                      : liveVoiceSnapshot.microphoneEnabled
                        ? "Turn microphone off"
                        : "Turn microphone on"}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    aria-pressed={liveVoiceSnapshot.outputMuted}
                    onClick={toggleLiveVoiceOutput}
                  >
                    {liveVoiceSnapshot.outputMuted ? "Hear table voice" : "Mute table voice"}
                  </button>
                  <button
                    type="button"
                    className="secondary-button danger-outline"
                    onClick={() => void leaveLiveVoice()}
                  >
                    Leave voice
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {testPlayerDialogOpen ? (
        <div
          ref={testPlayerDialogRef}
          className="choice-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="test-player-title"
          aria-describedby="test-player-description"
          tabIndex={-1}
        >
          <div className="choice-panel">
            <span className="eyebrow">Local development</span>
            <h2 id="test-player-title">Switch test player</h2>
            <p id="test-player-description" className="dialog-copy">
              Choose a name for a fresh local identity. The page will reload outside the current player&apos;s seat.
            </p>
            <form onSubmit={switchLocalPlayer}>
              <label className="input-label dialog-input" htmlFor="test-player-name">
                <span>Player name</span>
                <input
                  ref={testPlayerInputRef}
                  id="test-player-name"
                  name="test-player-name"
                  type="text"
                  autoComplete="off"
                  maxLength={28}
                  aria-required="true"
                  aria-invalid={Boolean(testPlayerNameError)}
                  aria-describedby={testPlayerNameError ? "test-player-name-error" : undefined}
                  value={testPlayerName}
                  onChange={(event) => {
                    setTestPlayerName(event.target.value);
                    if (testPlayerNameError) setTestPlayerNameError(null);
                  }}
                />
                {testPlayerNameError ? (
                  <span id="test-player-name-error" className="field-error" role="alert">
                    {testPlayerNameError}
                  </span>
                ) : null}
              </label>
              <div className="dialog-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={switchingTestPlayer}
                  onClick={closeTestPlayerDialog}
                >
                  Cancel
                </button>
                <button type="submit" className="primary-button" disabled={switchingTestPlayer}>
                  {switchingTestPlayer ? "Switching…" : "Switch player"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {pendingCard ? (
        <div
          ref={choiceDialogRef}
          className="choice-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="play-choice-title"
          tabIndex={-1}
        >
          <div className="choice-panel">
            <span className="eyebrow">Complete your play</span>
            <h2 id="play-choice-title">{cardLabel(pendingCard)}</h2>
            {pendingCard.kind === "wild_color_roulette" ? (
              <p className="roulette-choice-note">
                The next player—not you—chooses the color and draws until it appears. Their
                turn is skipped.
              </p>
            ) : null}
            {isWild(pendingCard) && pendingCard.kind !== "wild_color_roulette" ? (
              <fieldset>
                <legend>Continuing color</legend>
                <div className="choice-grid">
                  {COLORS.map((color) => (
                    <button
                      type="button"
                      key={color}
                      className={`color-choice card-${color} ${chosenColor === color ? "is-selected" : ""}`}
                      aria-pressed={chosenColor === color}
                      disabled={actionPending}
                      onClick={() => setChosenColor(color)}
                    >
                      {color}
                    </button>
                  ))}
                </div>
              </fieldset>
            ) : null}
            {pendingCard.kind === "number" && pendingCard.number === 7 ? (
              <fieldset>
                <legend>Mandatory hand swap</legend>
                <div className="target-list">
                  {activeOpponents.map((player) => (
                    <button
                      type="button"
                      key={player.playerId}
                      className={swapTargetId === player.playerId ? "is-selected" : ""}
                      aria-pressed={swapTargetId === player.playerId}
                      disabled={actionPending}
                      onClick={() => {
                        setSwapTargetId(player.playerId);
                        setDeclareWithPlay(false);
                      }}
                    >
                      <strong>{player.displayName}</strong>
                      <span>{player.cardCount} cards</span>
                    </button>
                  ))}
                </div>
              </fieldset>
            ) : null}
            {pendingWouldLeaveOne ? (
              <label className="uno-check">
                <input
                  type="checkbox"
                  checked={declareWithPlay}
                  disabled={actionPending}
                  onChange={(event) => setDeclareWithPlay(event.target.checked)}
                />
                Call UNO with this play
              </label>
            ) : null}
            <div className="dialog-actions">
              <button className="secondary-button" disabled={actionPending} onClick={closePendingChoice}>Cancel</button>
              <button className="primary-button" disabled={!pendingCanConfirm || actionPending} onClick={completePendingPlay}>Play card</button>
            </div>
          </div>
        </div>
      ) : null}

      <span className="sr-only" aria-live="polite">
        {busy ? "Sending action" : game ? `Game state revision ${game.revision}` : "Lobby browser ready"}
      </span>
    </main>
  );
}

function LobbyBrowser({
  nickname,
  setNickname,
  joinAlias,
  setJoinAlias,
  joinCode,
  setJoinCode,
  lobbies,
  publicRooms,
  busy,
  createLobby,
  joinLobby,
  openGame,
  openPublicJoin,
  openQuickJoin,
  refresh,
  openGuide,
}: {
  nickname: string;
  setNickname: (value: string) => void;
  joinAlias: string;
  setJoinAlias: (value: string) => void;
  joinCode: string;
  setJoinCode: (value: string) => void;
  lobbies: Lobbies;
  publicRooms: PublicRoomPage | null;
  busy: boolean;
  createLobby: () => void;
  joinLobby: (code?: string) => void;
  openGame: (id: string) => void;
  openPublicJoin: (room: PublicRoomCard, trigger: HTMLButtonElement) => void;
  openQuickJoin: (trigger: HTMLButtonElement) => void;
  refresh: () => void;
  openGuide: (topic: GuideTopic, trigger?: HTMLButtonElement) => void;
}) {
  return (
    <section className="lobby-browser">
      <div className="lobby-hero">
        <span className="eyebrow">Your next game night</span>
        <h1>Bring the players.<br /><em>Shed the cards.</em></h1>
        <p>
          Start a private table or join a friend. We keep hands private, remember the room, and settle every merciless rule so your group can stay in the game.
        </p>
        <div className="foundation-strip" aria-label="Player benefits">
          <span>Private hands</span>
          <span>2–6 players</span>
          <span>Full Mercy rules</span>
          <span>Rejoin anytime</span>
        </div>
      </div>

      <div className="lobby-controls">
        <div className="control-card create-card">
          <span className="step-number">01</span>
          <div>
            <span className="eyebrow">Start a table</span>
            <label className="input-label">
              <span>Display name</span>
              <input value={nickname} maxLength={28} onChange={(event) => setNickname(event.target.value)} placeholder="Player name" />
            </label>
            <button className="primary-button" disabled={busy || !nickname.trim()} onClick={createLobby}>Create a table</button>
          </div>
        </div>
        <div className="control-card join-card">
            <span className="step-number">02</span>
            <div>
              <span className="eyebrow">Join your friends</span>
              <label className="input-label join-alias-input">
                <span>Room alias</span>
                <input
                  value={joinAlias}
                  maxLength={ROOM_ALIAS_MAX_LENGTH}
                  autoComplete="off"
                  onChange={(event) => setJoinAlias(event.target.value)}
                  placeholder="Choose a table name"
                />
              </label>
              <label className="input-label">
                <span>Table code</span>
              <input
                className="code-input"
                value={joinCode}
                maxLength={6}
                onChange={(event) => setJoinCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                placeholder="ABC123"
              />
            </label>
            <button className="primary-button acid" disabled={busy || joinCode.length !== 6 || !joinAlias.trim()} onClick={() => joinLobby()}>Join the table</button>
          </div>
        </div>
      </div>

      {publicRooms ? (
        <section className="open-table-pool" aria-labelledby="open-table-pool-title">
          <div className="section-heading open-table-pool__heading">
            <div>
              <span className="eyebrow">Play with someone new</span>
              <h2 id="open-table-pool-title">Open tables</h2>
              <p>Choose a table, then confirm a room alias. Public cards never reveal player names or table codes.</p>
            </div>
            <div className="open-table-pool__actions">
              <button
                className="primary-button acid"
                disabled={busy || publicRooms.rooms.length === 0}
                onClick={(event) => openQuickJoin(event.currentTarget)}
              >
                Quick join
              </button>
              <button className="text-button" disabled={busy} onClick={refresh}>Refresh open tables</button>
            </div>
          </div>
          {publicRooms.rooms.length ? (
            <div className="open-table-grid">
              {publicRooms.rooms.map((room) => (
                <article className="open-table-card" key={room.listingId}>
                  <span className="open-table-card__pace">{room.pace === "quick" ? "Quick pace" : "Casual pace"}</span>
                  <strong>{room.occupancy}/{room.capacity} players</strong>
                  <span>{room.capacity - room.occupancy} {room.capacity - room.occupancy === 1 ? "seat" : "seats"} open</span>
                  <dl>
                    <div><dt>Rules</dt><dd>Merciless baseline</dd></div>
                    <div><dt>Waiting</dt><dd>{waitingAgeLabel(room.waitingAge)}</dd></div>
                  </dl>
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={(event) => openPublicJoin(room, event.currentTarget)}
                    aria-label={`Join an anonymous ${room.pace} table with ${room.occupancy} of ${room.capacity} players`}
                  >
                    Choose this table
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-room open-table-empty">
              <strong>No eligible open tables right now.</strong>
              <span>Refresh in a moment or create a private table and choose whether to publish it.</span>
            </div>
          )}
        </section>
      ) : null}

      <div className="rooms-section">
        <div className="section-heading">
          <div><span className="eyebrow">Rejoin tables</span><h2>Your games</h2></div>
          <button className="text-button" onClick={refresh}>Refresh rooms</button>
        </div>
        <div className="room-grid">
          {lobbies.mine.length ? lobbies.mine.map((room) => (
            <RoomCard key={room.gameId} room={room} actionLabel="Open" action={() => openGame(room.gameId)} />
          )) : <div className="empty-room"><strong>No rooms yet.</strong><span>Create the first table or join with a code.</span></div>}
        </div>
      </div>

      <div className="rules-note game-guide-entry">
        <div>
          <span className="eyebrow">New to the table?</span>
          <strong>Learn the merciless differences before your first card.</strong>
          <p>Stacking, 0/7 hand movement, Mercy at 25, UNO windows, and every action card stay one tap away during play.</p>
        </div>
        <div className="game-guide-entry-actions">
          <button className="secondary-button" onClick={(event) => openGuide("rules", event.currentTarget)}>Quick rules</button>
          <button className="secondary-button" onClick={(event) => openGuide("actions", event.currentTarget)}>Action guide</button>
        </div>
      </div>
      <footer className="lobby-product-footer">
        <ReleaseIdentity className="release-identity--lobby" />
      </footer>
    </section>
  );
}

function RoomCard({ room, actionLabel, action }: { room: LobbySummary; actionLabel: string; action: () => void }) {
  return (
    <article className="room-card">
      <span className="room-phase">{room.phase}</span>
      <strong>{room.joinCode}</strong>
      <span>{room.hostName} · {room.playerCount}/6 players</span>
      <button className="secondary-button" onClick={action}>{actionLabel}</button>
    </article>
  );
}

function setGameInUrl(gameId: string | null): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (gameId) {
    url.searchParams.set("game", gameId);
    url.searchParams.delete("join");
    url.searchParams.delete("listing");
  } else {
    url.searchParams.delete("game");
  }
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

function setListingInUrl(listingId: string): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.delete("game");
  url.searchParams.delete("join");
  url.searchParams.set("listing", listingId);
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

function clearListingFromUrl(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.delete("listing");
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

function clearJoinFromUrl(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.delete("join");
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

function normalizeJoinCodeFromUrl(search: string): string | null {
  const raw = new URLSearchParams(search).get("join");
  if (!raw) return null;
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  return code.length === 6 ? code : null;
}

function connectionLabel(state: ConnectionState): string {
  if (state === "syncing") return "Syncing action";
  if (state === "reconnecting") return "Reconnecting";
  if (state === "offline") return "Offline — action retry ready";
  return "Live table";
}

function presenceLabel(status: PresencePlayer["status"]): string {
  if (status === "reconnecting") return "Reconnecting";
  if (status === "disconnected") return "Offline";
  return "Live";
}

function getTurnCoach(
  game: GameView,
  selfPlayerId?: string,
): { title: string; detail: string; tone: "neutral" | "active" | "urgent" | "danger" } {
  if (game.phase === "complete") {
    return {
      title: `${game.winner?.displayName ?? "The table"} wins`,
      detail: "Review the result, rematch this group, or start a new table.",
      tone: "active",
    };
  }
  if (game.phase === "lobby") {
    return {
      title: game.players.filter((player) => player.status === "active").length < 2
        ? "Invite players to your table"
        : "Ready up to begin",
      detail: "Share the invite, then ready up when everyone arrives.",
      tone: "neutral",
    };
  }

  const catchableNames = game.legalActions.catchablePlayerIds
    .map((playerId) => game.players.find((player) => player.playerId === playerId)?.displayName)
    .filter((name): name is string => Boolean(name));
  if (catchableNames.length) {
    return {
      title: `Catch ${formatNameList(catchableNames)} now`,
      detail: "Their UNO window closes when the next substantive turn action is accepted.",
      tone: "danger",
    };
  }
  if (game.legalActions.canDeclareUno) {
    return {
      title: "Call UNO now",
      detail: "Declare before another player catches you or the next turn action closes the window.",
      tone: "urgent",
    };
  }

  const isSelfTurn = game.currentPlayerId === selfPlayerId;
  if (game.rouletteTargetId) {
    if (game.legalActions.canChooseRouletteColor) {
      return {
        title: "Choose your Roulette color",
        detail: "Cards reveal until that color appears. You take the full revealed batch and lose this turn.",
        tone: "urgent",
      };
    }
    const rouletteTarget = game.players.find(
      (player) => player.playerId === game.rouletteTargetId,
    );
    return {
      title: `${rouletteTarget?.displayName ?? "The next player"} must choose the Roulette color`,
      detail: "The player who played Color Roulette does not choose. The target draws until that color appears and loses this turn.",
      tone: "urgent",
    };
  }
  if (isSelfTurn && game.pendingDraw) {
    return {
      title: `Stack +${game.pendingDraw.minimum} or take ${game.pendingDraw.total}`,
      detail: "Only an equal-or-higher Draw Card can continue this penalty chain.",
      tone: "danger",
    };
  }
  if (isSelfTurn && game.forcedCardId) {
    return {
      title: "Play the card you just drew",
      detail: "The highlighted card is your first playable draw and must be played now.",
      tone: "active",
    };
  }
  if (game.legalActions.canDrawUntilPlayable) {
    return {
      title: "Your turn — draw until playable",
      detail: game.activeColor
        ? `No card in your hand matches ${game.activeColor}. The server stops at the first playable card, then asks you to play it.`
        : "No card in your hand matches. The server stops at the first playable card, then asks you to play it.",
      tone: "active",
    };
  }
  if (isSelfTurn) {
    return {
      title: "Your move — play a highlighted card",
      detail: game.activeColor
        ? `Match ${game.activeColor}, the top number or symbol, or play a Wild.`
        : "Match the top number or symbol, or play a Wild.",
      tone: "active",
    };
  }
  return {
    title: `${game.currentPlayerName ?? "Another player"} is playing`,
    detail: game.activeColor
      ? `${game.activeColor} is active. Your hand stays private while you wait.`
      : "Your hand stays private while you wait.",
    tone: "neutral",
  };
}

function formatNameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "A player";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

function formatChatTime(createdAt: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(createdAt));
}

function samePlayerMap(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([playerId, displayName]) => right[playerId] === displayName)
  );
}

function readStoredCommand(): StoredCommand | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(COMMAND_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredCommand>;
    if (
      typeof value.commandId !== "string" ||
      typeof value.gameId !== "string" ||
      typeof value.expectedRevision !== "number" ||
      typeof value.createdAt !== "number" ||
      !value.command ||
      typeof value.command !== "object" ||
      typeof (value.command as { type?: unknown }).type !== "string"
    ) {
      sessionStorage.removeItem(COMMAND_STORAGE_KEY);
      return null;
    }
    return value as StoredCommand;
  } catch {
    sessionStorage.removeItem(COMMAND_STORAGE_KEY);
    return null;
  }
}

function writeStoredCommand(record: StoredCommand): void {
  try {
    sessionStorage.setItem(COMMAND_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // The command still proceeds; recovery is unavailable in this tab.
  }
}

function clearStoredCommand(): void {
  try {
    sessionStorage.removeItem(COMMAND_STORAGE_KEY);
  } catch {
    // Storage may be unavailable in privacy-restricted contexts.
  }
}

function handCountAfterPlay(
  game: GameView,
  card: Card,
  swapTargetId: string | null,
): number | null {
  if (game.hand.length <= 1) return 0;
  if (card.kind === "discard_all" && card.color) {
    return game.hand.filter((candidate) => candidate.color !== card.color).length;
  }
  if (card.kind === "number" && card.number === 7) {
    return game.players.find((player) => player.playerId === swapTargetId)?.cardCount ?? null;
  }
  if (card.kind === "number" && card.number === 0) {
    const active = [...game.players]
      .filter((player) => player.status === "active")
      .sort((left, right) => left.seat - right.seat);
    const selfIndex = active.findIndex((player) => player.isSelf);
    if (selfIndex >= 0 && active.length > 1) {
      const donorIndex = (selfIndex - game.direction + active.length) % active.length;
      return active[donorIndex].cardCount;
    }
  }
  return game.hand.length - 1;
}

function getLocalIdentity(): { id: string; name: string } | null {
  if (typeof window === "undefined" || window.location.hostname !== "localhost") return null;
  const key = "open-shed-dev-identity";
  const stored = localStorage.getItem(key);
  if (stored) {
    try {
      return JSON.parse(stored) as { id: string; name: string };
    } catch {
      localStorage.removeItem(key);
    }
  }
  const created = { id: "local-player-1", name: "Local Player" };
  localStorage.setItem(key, JSON.stringify(created));
  return created;
}

function commandId(): string {
  return `cmd_${crypto.randomUUID().replaceAll("-", "_")}`;
}
