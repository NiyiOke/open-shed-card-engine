import assert from "node:assert/strict";
import test from "node:test";
import { GameRuleError } from "../lib/game/errors";
import type { AuthenticatedUser } from "../lib/server/auth";
import {
  createLiveVoiceSession,
  type LiveVoiceSessionDependencies,
} from "../lib/server/live-voice-store";
import type { LiveVoiceProviderConfig } from "../lib/server/live-voice-provider";

const GAME_ID = "voice-race-game";
const ISSUED_AT = 1_800_000_000_000;
const USER: AuthenticatedUser = {
  userId: "auth-host",
  suggestedName: "Host",
  development: false,
};
const PROVIDER: LiveVoiceProviderConfig = Object.freeze({
  serverUrl: "wss://voice.example.test",
  apiKey: "test-api-key",
  apiSecret: "test-api-secret",
});

type Race = "none" | "block" | "leave" | "publication";

test("voice token is returned only after a second complete eligibility read", async () => {
  const harness = voiceRaceHarness("none");
  const result = await createLiveVoiceSession(USER, GAME_ID, harness.dependencies);

  assert.equal(result.token, "minted-but-not-yet-returned");
  assert.match(result.participantIdentity, /^osp_[a-f0-9]{32}$/u);
  assert.deepEqual(harness.reads, {
    rooms: 2,
    members: 2,
    blocks: 2,
    cleanupBarriers: 2,
  });
  assert.deepEqual(harness.events, ["mint", "final-room-read"]);
});

for (const expectation of [
  { race: "block", code: "LIVE_VOICE_UNAVAILABLE" },
  { race: "leave", code: "NOT_A_MEMBER" },
  { race: "publication", code: "LIVE_VOICE_PRIVATE_ONLY" },
] as const) {
  test(`a ${expectation.race} committed during mint rejects the token and awaits cleanup`, async () => {
    const harness = voiceRaceHarness(expectation.race);
    await assert.rejects(
      createLiveVoiceSession(USER, GAME_ID, harness.dependencies),
      (error: unknown) => {
        assert.ok(error instanceof GameRuleError);
        assert.equal(error.code, expectation.code);
        harness.events.push("rejected");
        return true;
      },
    );

    assert.deepEqual(harness.cleanupCalls, [
      {
        gameId: GAME_ID,
        playerId: "player-host",
        issuedAt: ISSUED_AT,
      },
    ]);
    assert.deepEqual(harness.events.slice(-3), [
      "cleanup-start",
      "cleanup-finish",
      "rejected",
    ]);
  });
}

function voiceRaceHarness(race: Race): Readonly<{
  dependencies: LiveVoiceSessionDependencies;
  events: string[];
  cleanupCalls: Array<{
    gameId: string;
    playerId: string;
    issuedAt: number;
  }>;
  reads: {
    rooms: number;
    members: number;
    blocks: number;
    cleanupBarriers: number;
  };
}> {
  let afterMint = false;
  let clockReads = 0;
  const events: string[] = [];
  const cleanupCalls: Array<{
    gameId: string;
    playerId: string;
    issuedAt: number;
  }> = [];
  const reads = {
    rooms: 0,
    members: 0,
    blocks: 0,
    cleanupBarriers: 0,
  };
  const stateJson = JSON.stringify({
    players: [
      {
        userId: "auth-host",
        playerId: "player-host",
        displayName: "Host",
        status: "active",
      },
      {
        userId: "auth-guest",
        playerId: "player-guest",
        displayName: "Guest",
        status: "active",
      },
    ],
  });
  const members = [
    {
      profile_id: "profile-host",
      auth_subject: "auth-host",
      join_source: "host",
      actor: 1,
    },
    {
      profile_id: "profile-guest",
      auth_subject: "auth-guest",
      join_source: "invite",
      actor: 0,
    },
  ];

  const database = {
    prepare(sql: string) {
      const statement = {
        bind() {
          return statement;
        },
        async first<T>() {
          if (sql.includes("INSERT INTO mutation_quotas")) {
            return { count: 1 } as T;
          }
          if (sql.includes("FROM profile_blocks b")) {
            reads.blocks += 1;
            return (afterMint && race === "block"
              ? { blocked: 1 }
              : null) as T | null;
          }
          if (sql.includes("FROM live_voice_cleanup_jobs")) {
            reads.cleanupBarriers += 1;
            return null as T | null;
          }
          if (sql.includes("FROM games")) {
            reads.rooms += 1;
            if (afterMint) events.push("final-room-read");
            return {
              id: GAME_ID,
              room_status: "open",
              status: "lobby",
              communication_scope:
                afterMint && race === "publication"
                  ? "public_safe"
                  : "invite_only",
              state_json: stateJson,
              expires_at: ISSUED_AT + 60_000,
            } as T;
          }
          throw new Error(`Unexpected first() SQL: ${sql}`);
        },
        async all<T>() {
          if (!sql.includes("FROM game_members m")) {
            throw new Error(`Unexpected all() SQL: ${sql}`);
          }
          reads.members += 1;
          const results = afterMint && race === "leave"
            ? members.filter((member) => member.actor !== 1)
            : members;
          return { results } as unknown as D1Result<T>;
        },
      };
      return statement;
    },
  } as unknown as D1Database;

  return {
    events,
    cleanupCalls,
    reads,
    dependencies: {
      database,
      provider: PROVIDER,
      now: () => ISSUED_AT + clockReads++,
      mintToken: async (_provider, input) => {
        events.push("mint");
        assert.equal(input.participantIdentity.length > 0, true);
        afterMint = true;
        return {
          token: "minted-but-not-yet-returned",
          expiresAt: ISSUED_AT + 5 * 60_000,
        };
      },
      cleanupRejectedMint: async (_database, gameId, playerId, issuedAt) => {
        events.push("cleanup-start");
        cleanupCalls.push({ gameId, playerId, issuedAt });
        await Promise.resolve();
        events.push("cleanup-finish");
      },
    },
  };
}
