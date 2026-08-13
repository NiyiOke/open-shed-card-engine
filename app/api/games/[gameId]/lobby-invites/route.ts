import { GameRuleError } from "../../../../../lib/game/errors";
import {
  assertSafeMutationRequest,
  requireRequestUser,
} from "../../../../../lib/server/auth";
import { assertExactJsonKeys } from "../../../../../lib/server/communication-policy";
import { sendLobbyInvitation } from "../../../../../lib/server/lobby-presence-store";
import {
  jsonResponse,
  readJsonObject,
  requireCommandId,
  routeErrorResponse,
} from "../../../../../lib/server/responses";

type RouteContext = { params: Promise<{ gameId: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSafeMutationRequest(request);
    const user = requireRequestUser(request);
    const body = await readJsonObject(request);
    assertExactJsonKeys(
      body,
      ["commandId", "presenceId", "senderAlias"],
      "INVALID_LOBBY_INVITATION",
      "Invitations require only commandId, presenceId, and senderAlias.",
    );
    const commandId = requireCommandId(body.commandId);
    if (typeof body.presenceId !== "string" || typeof body.senderAlias !== "string") {
      throw new GameRuleError(
        "INVALID_LOBBY_INVITATION",
        "The invitation fields are invalid.",
        400,
      );
    }
    const { gameId } = await context.params;
    return jsonResponse(
      await sendLobbyInvitation(user, gameId, {
        commandId,
        presenceId: body.presenceId,
        senderAlias: body.senderAlias,
      }),
      201,
    );
  } catch (error) {
    return routeErrorResponse(error);
  }
}

