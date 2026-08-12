import type {
  GameView,
  GameSeriesScore,
  GameSeriesWinner,
  PlayerView,
} from "../../lib/game/types";

export type RankedSeriesScore = Readonly<{
  rank: number;
  score: GameSeriesScore;
}>;

type RefreshableGameView = Pick<GameView, "gameId" | "revision">;

/**
 * Admit viewer snapshots monotonically. Equal revisions are intentional:
 * server-time and presence-derived capabilities (such as host recovery) can
 * change without mutating the underlying game revision.
 */
export function canApplyRefreshedGameView(
  current: RefreshableGameView | null | undefined,
  incoming: RefreshableGameView,
  requestedGameId: string,
): boolean {
  return Boolean(
    current &&
    current.gameId === requestedGameId &&
    incoming.gameId === requestedGameId &&
    incoming.revision >= current.revision,
  );
}

export function rankSeriesScores(
  scores: readonly GameSeriesScore[],
  players: readonly Pick<PlayerView, "playerId" | "seat">[],
): RankedSeriesScore[] {
  const seatByPlayer = new Map(
    players.map((player) => [player.playerId, player.seat] as const),
  );
  const ordered = [...scores].sort((left, right) =>
    right.wins - left.wins ||
    (seatByPlayer.get(left.playerId) ?? Number.MAX_SAFE_INTEGER) -
      (seatByPlayer.get(right.playerId) ?? Number.MAX_SAFE_INTEGER) ||
    left.displayName.localeCompare(right.displayName),
  );

  let previousWins: number | null = null;
  let previousRank = 0;
  return ordered.map((score, index) => {
    const rank = previousWins === score.wins ? previousRank : index + 1;
    previousWins = score.wins;
    previousRank = rank;
    return { rank, score };
  });
}

export function seriesWinLabel(wins: number): string {
  const safeWins = Number.isSafeInteger(wins) && wins >= 0 ? wins : 0;
  return `${safeWins} ${safeWins === 1 ? "win" : "wins"}`;
}

export function roundLabel(roundNumber: number): string {
  const safeRound = Number.isSafeInteger(roundNumber) && roundNumber >= 1
    ? roundNumber
    : 1;
  return `Round ${safeRound}`;
}

export function winnerReasonLabel(
  reason: GameSeriesWinner["reason"],
): string {
  return reason === "empty_hand" ? "Shed every card" : "Last active player";
}
