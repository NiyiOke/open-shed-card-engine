import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  canApplyRefreshedGameView,
  rankSeriesScores,
  roundLabel,
  seriesWinLabel,
  winnerReasonLabel,
} from "../app/components/continuity-ui";

const GAME_SHELL_SOURCE = readFileSync(
  new URL("../app/components/GameShell.tsx", import.meta.url),
  "utf8",
);
const CSS_SOURCE = readFileSync(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);

test("viewer refreshes accept equal revisions without allowing gameplay regression", () => {
  const current = { gameId: "game-a", revision: 12 };

  assert.equal(
    canApplyRefreshedGameView(current, { gameId: "game-a", revision: 12 }, "game-a"),
    true,
    "equal revisions refresh server-time and presence-derived capabilities",
  );
  assert.equal(
    canApplyRefreshedGameView(current, { gameId: "game-a", revision: 13 }, "game-a"),
    true,
  );
  assert.equal(
    canApplyRefreshedGameView(current, { gameId: "game-a", revision: 11 }, "game-a"),
    false,
  );
  assert.equal(
    canApplyRefreshedGameView(current, { gameId: "game-b", revision: 13 }, "game-a"),
    false,
  );
  assert.equal(
    canApplyRefreshedGameView(null, { gameId: "game-a", revision: 12 }, "game-a"),
    false,
  );
  assert.match(
    GAME_SHELL_SOURCE,
    /canApplyRefreshedGameView\(current, response\.view, gameId\)/u,
  );
  assert.match(
    GAME_SHELL_SOURCE,
    /playedCardPulse:\s*Boolean\(\s*game\s*&&/u,
    "the semantic game client must not report an active card effect outside a game",
  );
  assert.match(
    GAME_SHELL_SOURCE,
    /selfTurnPulse:\s*Boolean\(\s*game\s*&&/u,
    "the semantic game client must not report an active turn effect outside a game",
  );
});

test("series scores rank wins first and keep tied seats deterministic", () => {
  const ranked = rankSeriesScores(
    [
      { playerId: "seat-three", displayName: "C", wins: 1 },
      { playerId: "seat-two", displayName: "B", wins: 3 },
      { playerId: "seat-one", displayName: "A", wins: 3 },
      { playerId: "departed", displayName: "D", wins: 0 },
    ],
    [
      { playerId: "seat-one", seat: 0 },
      { playerId: "seat-two", seat: 1 },
      { playerId: "seat-three", seat: 2 },
    ],
  );

  assert.deepEqual(
    ranked.map(({ rank, score }) => [rank, score.playerId, score.wins]),
    [
      [1, "seat-one", 3],
      [1, "seat-two", 3],
      [3, "seat-three", 1],
      [4, "departed", 0],
    ],
  );
  assert.equal(seriesWinLabel(1), "1 win");
  assert.equal(seriesWinLabel(2), "2 wins");
  assert.equal(roundLabel(3), "Round 3");
  assert.equal(winnerReasonLabel("empty_hand"), "Shed every card");
  assert.equal(winnerReasonLabel("last_active"), "Last active player");
});

test("host recovery and round continuity are bound to server-projected contracts", () => {
  assert.match(GAME_SHELL_SOURCE, /game\.legalActions\.canClaimHost/u);
  assert.match(GAME_SHELL_SOURCE, /sendCommand\(\{ type: "claim_host" \}\)/u);
  assert.match(GAME_SHELL_SOURCE, /game\.series\.scores/u);
  assert.match(GAME_SHELL_SOURCE, /game\.series\.recentWinners/u);
  assert.match(GAME_SHELL_SOURCE, /Play round \{nextRoundNumber\}/u);
  assert.match(CSS_SOURCE, /\.host-continuity\s*\{/u);
  assert.match(
    CSS_SOURCE,
    /@media \(max-width: 720px\)[\s\S]*?\.host-continuity\s*\{[\s\S]*?grid-template-columns:\s*1fr/u,
  );
  assert.match(
    CSS_SOURCE,
    /@media \(max-width: 720px\)[\s\S]*?\.result-sheet\s*\{[\s\S]*?width:\s*100%[\s\S]*?min-width:\s*0/u,
  );
  assert.match(
    CSS_SOURCE,
    /\.result-sheet h2\s*\{[\s\S]*?overflow-wrap:\s*anywhere/u,
  );
});
