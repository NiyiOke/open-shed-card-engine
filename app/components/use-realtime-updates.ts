"use client";

import { useEffect, useRef, useState } from "react";
import {
  createRealtimeController,
  type RealtimeClientState,
} from "./realtime-client";

type Request = <T>(path: string, options?: RequestInit) => Promise<T>;
type RefreshGame = (gameId?: string, queueAfterCurrent?: boolean) => Promise<boolean>;

export function useRealtimeUpdates(
  gameId: string | null,
  request: Request,
  refreshGame: RefreshGame,
  getCurrentGameId: () => string | null,
  refreshChat: () => void,
): RealtimeClientState {
  const [state, setState] = useState<RealtimeClientState>("fallback");
  const handlersRef = useRef({ request, refreshGame, getCurrentGameId, refreshChat });
  useEffect(() => {
    handlersRef.current = { request, refreshGame, getCurrentGameId, refreshChat };
  }, [getCurrentGameId, refreshChat, refreshGame, request]);

  useEffect(() => {
    if (!gameId) return;
    const controller = createRealtimeController({
      requestTicket: () => handlersRef.current.request<unknown>(
        `/api/games/${encodeURIComponent(gameId)}/realtime-ticket`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      ),
      onInvalidate: async (topics) => {
        if (handlersRef.current.getCurrentGameId() !== gameId) return;
        if (topics.includes("chat")) handlersRef.current.refreshChat();
        if (topics.includes("game")) {
          const refreshed = await handlersRef.current.refreshGame(gameId, true);
          if (!refreshed) throw new Error("Authoritative game catch-up failed.");
        }
      },
      onStateChange: setState,
    });
    controller.start();
    const reconnect = () => controller.reconnectNow();
    window.addEventListener("online", reconnect);
    return () => {
      window.removeEventListener("online", reconnect);
      controller.stop();
    };
  }, [gameId]);

  return state;
}
