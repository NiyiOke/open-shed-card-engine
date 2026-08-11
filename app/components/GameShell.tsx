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
import { CardFace } from "./CardFace";
import { GameTableCanvas } from "./GameTableCanvas";
import { SignedOutLanding } from "./SignedOutLanding";

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
};
type PollRequest = {
  controller: AbortController;
  gameId: string;
  promise: Promise<boolean>;
};

const COMMAND_STORAGE_KEY = "open-shed-inflight-command-v1";
const REQUEST_TIMEOUT_MS = 12_000;

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
  const [removeTargetId, setRemoveTargetId] = useState<string | null>(null);
  const [storedCommand, setStoredCommand] = useState<StoredCommand | null>(null);
  const [sidebarDetailsOpen, setSidebarDetailsOpen] = useState(false);
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
  const storedRetryKeyRef = useRef<string | null>(null);
  const presenceAvailableRef = useRef(true);
  const testClock = useRef(0);
  const [reconnectTick, setReconnectTick] = useState(0);

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

  const loadLobbies = useCallback(async () => {
    try {
      setLobbies(await request<Lobbies>("/api/games"));
    } catch {
      // Lobby discovery is secondary to an active table and retries on focus.
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
        if (next.signedIn) void loadLobbies();
      })
      .catch(() => {
        if (!cancelled) setSession({ signedIn: false, displayName: "", development: false });
      });
    return () => {
      cancelled = true;
    };
  }, [loadLobbies, request]);

  useEffect(() => {
    const code = normalizeJoinCodeFromUrl(window.location.search);
    const hasLinkedGame = new URLSearchParams(window.location.search).has("game");
    const frame = window.requestAnimationFrame(() => {
      if (code) {
        const authUrl = new URL(signInPath, window.location.origin);
        authUrl.searchParams.set("return_to", `/?join=${encodeURIComponent(code)}`);
        setResolvedSignInPath(`${authUrl.pathname}${authUrl.search}`);
        setJoinCode(code);
        setInviteCode(code);
        setInviteDialogOpen(!hasLinkedGame);
      } else {
        setResolvedSignInPath(signInPath);
      }
      setStoredCommand(readStoredCommand());
    });
    return () => window.cancelAnimationFrame(frame);
  }, [signInPath]);

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
        if (
          !current ||
          current.gameId !== gameId ||
          response.view.gameId !== gameId ||
          response.view.revision <= current.revision
        ) {
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

  useEffect(() => {
    gameRef.current = game;
  }, [game]);

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
      if (!gameRef.current) void loadLobbies();
    };
    window.addEventListener("focus", retryReconnect);
    window.addEventListener("online", retryReconnect);
    return () => {
      window.removeEventListener("focus", retryReconnect);
      window.removeEventListener("online", retryReconnect);
    };
  }, [loadLobbies]);

  useEffect(() => {
    if (!shareFeedback) return;
    const timeout = window.setTimeout(() => setShareFeedback(null), 4_000);
    return () => window.clearTimeout(timeout);
  }, [shareFeedback]);

  useEffect(() => {
    window.render_game_to_text = () =>
      JSON.stringify({
        coordinateSystem: "Canvas origin is top-left; x increases right and y increases down.",
        mode: game?.phase ?? (session?.signedIn ? "lobby-browser" : "signed-out"),
        connection: connectionState,
        savedAction: storedCommand
          ? { gameId: storedCommand.gameId, type: storedCommand.command.type }
          : null,
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
              coach: getTurnCoach(game, game.players.find((player) => player.isSelf)?.playerId),
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
  }, [connectionState, game, presence, session, storedCommand]);

  const enterGame = useCallback((
    view: GameView,
    initialEvents: EventLine[] = [],
    eventCursor = view.revision,
    initialPresence: PresenceSnapshot | null = null,
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
    setConnectionState("live");
    setError(null);
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
    setError(null);
    setGameInUrl(null);
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "auto" }));
    void loadLobbies();
  }, [loadLobbies]);

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
      const response = await request<{ view: GameView }>("/api/games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandId: commandId(), nickname }),
      });
      enterGame(response.view);
    });
  };

  const joinLobby = async (code = joinCode) => {
    return runBusy(async () => {
      const response = await request<{ view: GameView }>("/api/games/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandId: commandId(), joinCode: code, nickname }),
      });
      enterGame(response.view);
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
    clearJoinFromUrl();
    setInviteCode(null);
  };

  const confirmInvite = async () => {
    if (!inviteCode) return;
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

  const self = game?.players.find((player) => player.isSelf) ?? null;
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
  const removeTarget = game?.players.find((player) => player.playerId === removeTargetId) ?? null;
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
    inviteDialogOpen ||
    Boolean(guideTopic) ||
    Boolean(removeTargetId);

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
    if (!inviteDialogOpen && !guideTopic && !removeTargetId) return;
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
  }, [closeGuide, closeInactiveRemoval, guideTopic, inviteDialogOpen, removeTargetId]);

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
            onClick={(event) => openGuide("rules", event.currentTarget)}
          >
            Rules &amp; cards
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
            <a className="text-button" href="/signout-with-chatgpt?return_to=/">Sign out</a>
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
            joinCode={joinCode}
            setJoinCode={setJoinCode}
            lobbies={lobbies}
            busy={busy}
            createLobby={() => void createLobby()}
            joinLobby={(code) => void joinLobby(code)}
            openGame={(id) => void openGame(id)}
            refresh={() => void loadLobbies()}
            openGuide={openGuide}
          />
        ) : (
          <section
            className="game-layout"
            aria-label="Current multiplayer game"
          >
          <div className="table-column">
            <div className={`table-status coach-${turnCoach?.tone ?? "neutral"}`} aria-live="polite">
              <span className="eyebrow">{game.phase === "lobby" ? "Lobby" : game.phase === "complete" ? "Result" : "Current turn"}</span>
              <strong>{turnCoach?.title}</strong>
              <span>{game.phase === "lobby" ? lobbyReadiness : turnCoach?.detail}</span>
            </div>

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
                    Draw until playable
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
                <span className="eyebrow">Round complete</span>
                <h2 id="result-title">{game.winner?.displayName ?? "The table"} wins.</h2>
                <p>
                  {game.winner?.reason === "empty_hand"
                    ? "They shed their final card before the table could answer."
                    : "They survived as the last active player under the Mercy rule."}
                </p>
                <div className="result-standings" aria-label="Final player standings">
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
                <div className="result-actions">
                  {canRematch ? (
                    <button className="primary-button acid" disabled={actionPending} onClick={() => void sendCommand({ type: "rematch" })}>
                      Rematch with this table
                    </button>
                  ) : game.isHost ? null : (
                    <span className="waiting-copy">The host can start a rematch.</span>
                  )}
                  <button className="secondary-button" disabled={actionPending} onClick={() => void leaveTable()}>Leave table and go back</button>
                  <button className="secondary-button" disabled={actionPending} onClick={() => void createLobby()}>Create a new table</button>
                </div>
              </section>
            ) : (
              <GameTableCanvas game={game} />
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
              <span className="revision">STATE v{game.revision}</span>
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
              Players &amp; activity
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
            </div>
            <button
              className="secondary-button leave-button"
              disabled={actionPending}
              onClick={() => void leaveTable()}
            >
              {game.phase === "complete" ? "Leave table and go back" : "Leave table"}
            </button>
          </aside>
          </section>
        )}
      </div>

      {inviteDialogOpen || guideTopic || removeTarget ? (
        <div
          ref={utilityDialogRef}
          className="choice-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby={
            inviteDialogOpen
              ? "invite-dialog-title"
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
                Confirm your table name, then join the lobby. No code entry needed.
              </p>
              <label className="input-label dialog-input" htmlFor="invite-player-name">
                <span>Playing as</span>
                <input
                  id="invite-player-name"
                  value={nickname}
                  maxLength={28}
                  onChange={(event) => setNickname(event.target.value)}
                  autoComplete="nickname"
                />
              </label>
              {inviteError ? <p className="field-error invite-error" role="alert">{inviteError}</p> : null}
              <div className="dialog-actions">
                <button className="secondary-button" disabled={busy} onClick={dismissInvite}>Use another code</button>
                <button className="primary-button acid" disabled={busy || !nickname.trim()} onClick={() => void confirmInvite()}>
                  {busy ? "Joining…" : "Join this table"}
                </button>
              </div>
            </div>
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
  joinCode,
  setJoinCode,
  lobbies,
  busy,
  createLobby,
  joinLobby,
  openGame,
  refresh,
  openGuide,
}: {
  nickname: string;
  setNickname: (value: string) => void;
  joinCode: string;
  setJoinCode: (value: string) => void;
  lobbies: Lobbies;
  busy: boolean;
  createLobby: () => void;
  joinLobby: (code?: string) => void;
  openGame: (id: string) => void;
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
            <button className="primary-button acid" disabled={busy || joinCode.length !== 6 || !nickname.trim()} onClick={() => joinLobby()}>Join the table</button>
          </div>
        </div>
      </div>

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
  } else {
    url.searchParams.delete("game");
  }
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
  if (game.legalActions.canChooseRouletteColor) {
    return {
      title: "Choose your Roulette color",
      detail: "Cards reveal until that color appears. You take the full revealed batch.",
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
      title: "No match — draw to a playable card",
      detail: "The server stops at the first playable card, then asks you to play it.",
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
