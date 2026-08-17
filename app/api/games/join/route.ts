import { assertSafeMutationRequest, requireRequestUser } from "../../../../lib/server/auth";
import {
  getViewerListingForGame,
  joinGame,
} from "../../../../lib/server/game-store";
import { GameRuleError } from "../../../../lib/game/errors";
import {
  jsonResponse,
  readJsonObject,
  requireCommandId,
  routeErrorResponse,
} from "../../../../lib/server/responses";
import { notifyRealtimeChange } from "../../../../lib/server/realtime-notify";

export async function POST(request: Request) {
  try {
    assertSafeMutationRequest(request);
    const user = requireRequestUser(request);
    const body = await readJsonObject(request);
    const commandId = requireCommandId(body.commandId);
    if (typeof body.joinCode !== "string") {
      throw new GameRuleError("INVALID_JOIN_CODE", "joinCode is required.", 400);
    }
    if (typeof body.nickname !== "string") {
      throw new GameRuleError(
        "INVALID_ALIAS",
        "Enter a room alias before joining.",
        400,
      );
    }
    const joined = await joinGame(user, body.nickname, body.joinCode, commandId);
    const view = joined.view;
    const listing = await getViewerListingForGame(user, view.gameId);
    if (!joined.replayed) {
      await notifyRealtimeChange(view.gameId, ["game", "chat"]);
    }
    return jsonResponse({ view, ...(listing ? { listing } : {}) });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
