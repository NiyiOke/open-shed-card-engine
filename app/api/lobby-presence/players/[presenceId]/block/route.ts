import {
  assertSafeMutationRequest,
  requireRequestUser,
} from "../../../../../../lib/server/auth";
import { assertExactJsonKeys } from "../../../../../../lib/server/communication-policy";
import { blockLobbyPresencePlayer } from "../../../../../../lib/server/lobby-presence-store";
import {
  jsonResponse,
  readJsonObject,
  requireCommandId,
  routeErrorResponse,
} from "../../../../../../lib/server/responses";

type RouteContext = { params: Promise<{ presenceId: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSafeMutationRequest(request);
    const user = requireRequestUser(request);
    const body = await readJsonObject(request);
    assertExactJsonKeys(
      body,
      ["commandId"],
      "INVALID_LOBBY_SAFETY_ACTION",
      "Lobby block requests require only commandId.",
    );
    const commandId = requireCommandId(body.commandId);
    const { presenceId } = await context.params;
    return jsonResponse(
      await blockLobbyPresencePlayer(user, presenceId, commandId),
    );
  } catch (error) {
    return routeErrorResponse(error);
  }
}

