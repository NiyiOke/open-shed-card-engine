import { GameRuleError } from "../../../../lib/game/errors";
import {
  assertSafeMutationRequest,
  requireRequestUser,
} from "../../../../lib/server/auth";
import { quickJoinPublicRoom } from "../../../../lib/server/game-store";
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
    if (typeof body.alias !== "string") {
      throw new GameRuleError(
        "INVALID_ALIAS",
        "Enter a room alias before joining.",
        400,
      );
    }
    const result = await quickJoinPublicRoom(user, body.alias, commandId);
    if (!result.replayed) {
      await notifyRealtimeChange(result.snapshot.view.gameId, ["game", "chat"]);
    }
    return jsonResponse(result.snapshot);
  } catch (error) {
    return routeErrorResponse(error);
  }
}
