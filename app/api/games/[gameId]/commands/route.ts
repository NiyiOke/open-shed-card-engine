import { parseGameCommand } from "../../../../../lib/server/command-parser";
import { GameRuleError } from "../../../../../lib/game/errors";
import { assertSafeMutationRequest, requireRequestUser } from "../../../../../lib/server/auth";
import {
  executeGameCommand,
  getViewerListingForGame,
} from "../../../../../lib/server/game-store";
import {
  jsonResponse,
  readJsonObject,
  requireCommandId,
  routeErrorResponse,
} from "../../../../../lib/server/responses";
import { reconcileLiveVoiceCleanupForGame } from "../../../../../lib/server/live-voice-cleanup";
import { notifyRealtimeChange } from "../../../../../lib/server/realtime-notify";

type RouteContext = { params: Promise<{ gameId: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSafeMutationRequest(request);
    const user = requireRequestUser(request);
    const { gameId } = await context.params;
    const body = await readJsonObject(request);
    const commandId = requireCommandId(body.commandId);
    const expectedRevision = body.expectedRevision;
    if (
      typeof expectedRevision !== "number" ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0
    ) {
      throw new GameRuleError(
        "INVALID_REVISION",
        "expectedRevision must be a non-negative integer.",
        400,
      );
    }
    const command = parseGameCommand(body.command);
    const result = await executeGameCommand(
      user,
      gameId,
      expectedRevision,
      commandId,
      command,
    );
    // A replay returns no events, so reconcile the durable cleanup outbox on
    // every accepted response. Provider failures never change game success.
    await reconcileLiveVoiceCleanupForGame(gameId);
    const listing = result.view
      ? await getViewerListingForGame(user, gameId)
      : undefined;
    if (!result.replayed) {
      await notifyRealtimeChange(
        gameId,
        command.type === "leave_game" ? ["game", "chat"] : ["game"],
      );
    }
    return jsonResponse({ ...result, ...(listing ? { listing } : {}) });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
