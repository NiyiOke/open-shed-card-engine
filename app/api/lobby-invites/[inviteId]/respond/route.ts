import { GameRuleError } from "../../../../../lib/game/errors";
import {
  assertSafeMutationRequest,
  requireRequestUser,
} from "../../../../../lib/server/auth";
import { assertExactJsonKeys } from "../../../../../lib/server/communication-policy";
import { respondToLobbyInvitation } from "../../../../../lib/server/lobby-presence-store";
import {
  jsonResponse,
  readJsonObject,
  requireCommandId,
  routeErrorResponse,
} from "../../../../../lib/server/responses";
import { notifyRealtimeChange } from "../../../../../lib/server/realtime-notify";

type RouteContext = { params: Promise<{ inviteId: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSafeMutationRequest(request);
    const user = requireRequestUser(request);
    const body = await readJsonObject(request);
    assertExactJsonKeys(
      body,
      ["commandId", "action"],
      "INVALID_LOBBY_INVITATION_RESPONSE",
      "Invitation responses require only commandId and action.",
    );
    const commandId = requireCommandId(body.commandId);
    if (
      body.action !== "accept" &&
      body.action !== "decline" &&
      body.action !== "decline_and_block"
    ) {
      throw new GameRuleError(
        "INVALID_LOBBY_INVITATION_RESPONSE",
        "Choose accept, decline, or decline and block.",
        400,
      );
    }
    const { inviteId } = await context.params;
    const result = await respondToLobbyInvitation(user, inviteId, {
      commandId,
      action: body.action,
    });
    if ("snapshot" in result && !result.invite.replayed) {
      await notifyRealtimeChange(result.snapshot.view.gameId, ["game", "chat"]);
    }
    return jsonResponse(result);
  } catch (error) {
    return routeErrorResponse(error);
  }
}
