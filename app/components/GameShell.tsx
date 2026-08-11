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
type GameSnapshotResponse = {
  view: GameView;
  events?: EventLine[];
  eventCursor?: number;
};
type PollRequest = {
  controller: AbortController;
  gameId: string;
  promise: Promise<boolean>;
};

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
  const gameRef = useRef<GameView | null>(null);
  const eventCursorRef = useRef<{ gameId: string; revision: number } | null>(null);
  const pollRequestRef = useRef<PollRequest | null>(null);
  const deepLinkInFlight = useRef<string | null>(null);
  const choiceDialogRef = useRef<HTMLDivElement>(null);
  const choiceTriggerRef = useRef<HTMLButtonElement | null>(null);
  const testPlayerDialogRef = useRef<HTMLDivElement>(null);
  const testPlayerInputRef = useRef<HTMLInputElement>(null);
  const testPlayerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const testPlayerSwitchingRef = useRef(false);
  const testClock = useRef(0);
  const [reconnectTick, setReconnectTick] = useState(0);

  const request = useCallback(async <T,>(path: string, options?: RequestInit) => {
    const headers = new Headers(options?.headers);
    const localIdentity = getLocalIdentity();
    if (localIdentity) {
      headers.set("X-Open-Shed-Dev-User", localIdentity.id);
      headers.set("X-Open-Shed-Dev-Name", localIdentity.name);
    }
    const response = await fetch(path, { ...options, headers, cache: "no-store" });
    const body = (await response.json()) as T & {
      error?: { code: string; message: string };
    };
    if (!response.ok) {
      const failure = new Error(body.error?.message ?? "Request failed.") as RequestFailure;
      failure.code = body.error?.code;
      throw failure;
    }
    return body;
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
        const code = (failure as RequestFailure).code;
        if (
          gameRef.current?.gameId === gameId &&
          ["AUTHENTICATION_REQUIRED", "GAME_EXPIRED", "GAME_NOT_FOUND", "NOT_A_MEMBER"].includes(
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
    if (!activeGameId || activeGamePhase === "complete") return;
    let cancelled = false;
    let timeout: number | null = null;

    const schedule = () => {
      if (cancelled) return;
      if (timeout !== null) window.clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        void refreshGame(activeGameId).finally(schedule);
      }, document.hidden ? 10_000 : 1_500);
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
    window.render_game_to_text = () =>
      JSON.stringify({
        coordinateSystem: "Canvas origin is top-left; x increases right and y increases down.",
        mode: game?.phase ?? (session?.signedIn ? "lobby-browser" : "signed-out"),
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
              })),
              ownHand: game.hand.map((card) => ({ id: card.id, label: cardLabel(card) })),
              legalActions: game.legalActions,
              winner: game.winner,
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
  }, [game, session]);

  const enterGame = useCallback((
    view: GameView,
    initialEvents: EventLine[] = [],
    eventCursor = view.revision,
  ) => {
    if (pollRequestRef.current?.gameId !== view.gameId) {
      pollRequestRef.current?.controller.abort();
      pollRequestRef.current = null;
    }
    gameRef.current = view;
    eventCursorRef.current = { gameId: view.gameId, revision: eventCursor };
    setGame(view);
    setEvents(initialEvents.slice(-12));
    setError(null);
    setGameInUrl(view.gameId);
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
    setError(null);
    setGameInUrl(null);
    void loadLobbies();
  }, [loadLobbies]);

  const createLobby = async () => {
    await runBusy(async () => {
      const response = await request<{ view: GameView }>("/api/games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandId: commandId(), nickname }),
      });
      enterGame(response.view);
    });
  };

  const joinLobby = async (code = joinCode) => {
    await runBusy(async () => {
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
      );
    });
  };

  const sendCommand = async (command: GameCommand): Promise<boolean> => {
    const commandGame = gameRef.current;
    if (!commandGame) return false;
    return runBusy(async () => {
      try {
        const response = await request<{
          view?: GameView;
          events?: EventLine[];
          replayed: boolean;
        }>(`/api/games/${encodeURIComponent(commandGame.gameId)}/commands`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            commandId: commandId(),
            expectedRevision: commandGame.revision,
            command,
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
          command.type !== "leave_game" &&
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
      } catch (failure) {
        if ((failure as RequestFailure).code === "VERSION_CONFLICT") {
          await refreshGame(commandGame.gameId);
        }
        throw failure;
      }
    });
  };

  const runBusy = async (work: () => Promise<void>): Promise<boolean> => {
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
          );
        }
      })
      .catch((failure) => {
        if (cancelled) return;
        setError(failure instanceof Error ? failure.message : "Game could not be opened.");
        const code = (failure as RequestFailure).code;
        if (["GAME_EXPIRED", "GAME_NOT_FOUND", "NOT_A_MEMBER"].includes(code ?? "")) {
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

  const leaveTable = async () => {
    if (!gameRef.current) return;
    if (gameRef.current.phase === "complete") {
      openLobbyBrowser();
      return;
    }
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
  const modalOpen = Boolean(pendingCard) || testPlayerDialogOpen;

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

  if (!session) {
    return (
      <main className="loading-screen" role="status">
        <span className="loading-dot" />
        Preparing the table…
      </main>
    );
  }

  if (!session.signedIn) {
    return <SignedOutLanding signInPath={signInPath} />;
  }

  return (
    <main className="open-shed-app">
      <header className="app-header" inert={modalOpen ? true : undefined}>
        <button className="wordmark" onClick={openLobbyBrowser} aria-label="Open lobby browser">
          <span>OPEN</span>
          <span>SHED</span>
        </button>
        <div className="header-note">
          <span className="status-pip" />
          Server authority active
        </div>
        <div className="header-account">
          <span>{nickname || session.displayName}</span>
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
          <button onClick={() => setError(null)} aria-label="Dismiss error">×</button>
        </div>
      ) : null}

      <div className="app-view" inert={modalOpen ? true : undefined}>
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
          />
        ) : (
          <section
            className="game-layout"
            aria-label="Current multiplayer game"
          >
          <aside className="game-sidebar">
            <div className="room-block">
              <span className="eyebrow">Lobby code</span>
              <button
                className="room-code"
                onClick={() => void navigator.clipboard.writeText(game.joinCode)}
                aria-label={`Copy lobby code ${game.joinCode}`}
              >
                {game.joinCode}
              </button>
              <span className="revision">STATE v{game.revision}</span>
            </div>
            <div className="players-list" aria-label="Players">
              {game.players.map((player) => (
                <div
                  className={`player-row ${player.playerId === game.currentPlayerId ? "is-current" : ""}`}
                  key={player.playerId}
                  aria-current={player.playerId === game.currentPlayerId ? "true" : undefined}
                >
                  <span className="seat-number">{String(player.seat + 1).padStart(2, "0")}</span>
                  <span className="player-copy">
                    <strong>{player.displayName}{player.isSelf ? " (you)" : ""}</strong>
                    <small>{player.status === "active" ? `${player.cardCount} cards` : player.status}</small>
                  </span>
                  <span className={`ready-mark ${player.ready ? "is-ready" : ""}`}>
                    {game.phase === "lobby" ? (player.ready ? "READY" : "WAIT") : player.status === "active" ? "IN" : "OUT"}
                  </span>
                </div>
              ))}
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
              )) : <p>Actions from this device will appear here.</p>}
            </div>
            <button
              className="secondary-button leave-button"
              disabled={busy}
              onClick={() => void leaveTable()}
            >
              {game.phase === "complete" ? "Back to lobby" : "Leave table"}
            </button>
          </aside>

          <div className="table-column">
            <div className="table-status" aria-live="polite">
              <span className="eyebrow">{game.phase === "lobby" ? "Lobby" : game.phase === "complete" ? "Result" : "Current turn"}</span>
              <strong>
                {game.winner
                  ? `${game.winner.displayName} wins`
                  : game.phase === "lobby"
                    ? "Ready up to begin"
                    : game.currentPlayerId === self?.playerId
                      ? "Your move"
                      : `${game.currentPlayerName}'s move`}
              </strong>
              <span>
                {game.pendingDraw
                  ? `Stack ${game.pendingDraw.minimum}+ or draw ${game.pendingDraw.total}`
                  : game.rouletteTargetId
                    ? "Color Roulette is waiting"
                    : game.activeColor
                      ? `${game.activeColor} is active`
                      : "Foundation rules v1"}
              </span>
            </div>
            <GameTableCanvas game={game} />

            {game.phase === "lobby" ? (
              <div className="lobby-actions">
                <button
                  className={self?.ready ? "secondary-button" : "primary-button"}
                  disabled={busy}
                  onClick={() => void sendCommand({ type: "set_ready", ready: !self?.ready })}
                >
                  {self?.ready ? "Mark not ready" : "I’m ready"}
                </button>
                {game.isHost ? (
                  <button
                    className="primary-button acid"
                    disabled={busy || !game.legalActions.canStart}
                    onClick={() => void sendCommand({ type: "start_game" })}
                  >
                    Start game
                  </button>
                ) : <span className="waiting-copy">Waiting for the host.</span>}
              </div>
            ) : null}

            {game.phase === "playing" ? (
              <div className="turn-actions">
                {game.legalActions.canChooseRouletteColor ? (
                  <div className="choice-row" role="group" aria-label="Choose Color Roulette color">
                    <strong>Choose a color to reveal</strong>
                    {COLORS.map((color) => (
                      <button
                        key={color}
                        className={`color-choice card-${color}`}
                        disabled={busy}
                        onClick={() => void sendCommand({ type: "choose_roulette_color", color })}
                      >
                        {color}
                      </button>
                    ))}
                  </div>
                ) : null}
                {game.legalActions.canAcceptPenalty ? (
                  <button className="primary-button danger" disabled={busy} onClick={() => void sendCommand({ type: "accept_penalty" })}>
                    Draw {game.pendingDraw?.total}
                  </button>
                ) : null}
                {game.legalActions.canDrawUntilPlayable ? (
                  <button className="primary-button" disabled={busy} onClick={() => void sendCommand({ type: "draw_until_playable" })}>
                    Draw until playable
                  </button>
                ) : null}
                {game.legalActions.canDeclareUno ? (
                  <button className="primary-button acid" disabled={busy} onClick={() => void sendCommand({ type: "declare_uno" })}>
                    Call UNO
                  </button>
                ) : null}
                {game.legalActions.catchablePlayerIds.map((playerId) => {
                  const player = game.players.find((candidate) => candidate.playerId === playerId);
                  return (
                    <button key={playerId} className="primary-button danger" disabled={busy} onClick={() => void sendCommand({ type: "catch_uno", offenderPlayerId: playerId })}>
                      Catch {player?.displayName ?? "player"}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {game.phase !== "lobby" ? (
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
                          pending: busy,
                          onActivate: selectCard,
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
          </section>
        )}
      </div>

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
                      disabled={busy}
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
                      disabled={busy}
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
                  disabled={busy}
                  onChange={(event) => setDeclareWithPlay(event.target.checked)}
                />
                Call UNO with this play
              </label>
            ) : null}
            <div className="dialog-actions">
              <button className="secondary-button" disabled={busy} onClick={closePendingChoice}>Cancel</button>
              <button className="primary-button" disabled={!pendingCanConfirm || busy} onClick={completePendingPlay}>Play card</button>
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
}) {
  return (
    <section className="lobby-browser">
      <div className="lobby-hero">
        <span className="eyebrow">Online shedding-card foundation</span>
        <h1>Multiplayer,<br /><em>rules first.</em></h1>
        <p>
          Create a room, share the six-character code, and play a complete Mercy ruleset with private hands and authoritative turns.
        </p>
        <div className="foundation-strip" aria-label="Foundation capabilities">
          <span>168-card model</span>
          <span>2–6 players</span>
          <span>Durable state</span>
          <span>Reconnect safe</span>
        </div>
      </div>

      <div className="lobby-controls">
        <div className="control-card create-card">
          <span className="step-number">01</span>
          <div>
            <span className="eyebrow">Your table name</span>
            <label className="input-label">
              <span>Display name</span>
              <input value={nickname} maxLength={28} onChange={(event) => setNickname(event.target.value)} placeholder="Player name" />
            </label>
            <button className="primary-button" disabled={busy || !nickname.trim()} onClick={createLobby}>Create a lobby</button>
          </div>
        </div>
        <div className="control-card join-card">
          <span className="step-number">02</span>
          <div>
            <span className="eyebrow">Have a code?</span>
            <label className="input-label">
              <span>Lobby code</span>
              <input
                className="code-input"
                value={joinCode}
                maxLength={6}
                onChange={(event) => setJoinCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                placeholder="ABC123"
              />
            </label>
            <button className="primary-button acid" disabled={busy || joinCode.length !== 6 || !nickname.trim()} onClick={() => joinLobby()}>Join by code</button>
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

      <details className="rules-note">
        <summary>What the baseline already enforces</summary>
        <div>
          <p>Match color, number, or symbol. If nothing matches, draw until a playable card appears and play that card.</p>
          <p>Equal-or-higher draw stacking, immediate Mercy at 25 cards, mandatory 0 passes and 7 swaps, all action cards, UNO reaction windows, and two ways to win are server-authoritative.</p>
          <p>Rich graphics, sound, chat, and live media are deliberately left as later modules.</p>
        </div>
      </details>
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
  if (gameId) url.searchParams.set("game", gameId);
  else url.searchParams.delete("game");
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
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
