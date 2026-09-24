import { GameRuleError } from "../../../../../../lib/game/errors";
import {
  assertSafeMutationRequest,
  requireRequestUser,
} from "../../../../../../lib/server/auth";
import { joinPublicRoom } from "../../../../../../lib/server/game-store";
import {
  jsonResponse,
  readJsonObject,
  requireCommandId,
  routeErrorResponse,
} from "../../../../../../lib/server/responses";
import { notifyRealtimeChange } from "../../../../../../lib/server/realtime-notify";

type RouteContext = { params: Promise<{ listingId: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSafeMutationRequest(request);
    const user = requireRequestUser(request);
    const { listingId } = await context.params;
    const body = await readJsonObject(request);
    const commandId = requireCommandId(body.commandId);
    if (typeof body.alias !== "string") {
      throw new GameRuleError(
        "INVALID_ALIAS",
        "Enter a room alias before joining.",
        400,
      );
    }
    const result = await joinPublicRoom(user, listingId, body.alias, commandId);
    if (!result.replayed) {
      await notifyRealtimeChange(result.snapshot.view.gameId, ["game", "chat"]);
    }
    return jsonResponse(result.snapshot);
  } catch (error) {
    return routeErrorResponse(error);
  }
}
