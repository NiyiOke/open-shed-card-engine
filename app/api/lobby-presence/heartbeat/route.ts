import {
  assertSafeMutationRequest,
  requireRequestUser,
} from "../../../../lib/server/auth";
import { assertExactJsonKeys } from "../../../../lib/server/communication-policy";
import { heartbeatLobbyPresence } from "../../../../lib/server/lobby-presence-store";
import {
  jsonResponse,
  readJsonObject,
  routeErrorResponse,
} from "../../../../lib/server/responses";

export async function POST(request: Request) {
  try {
    assertSafeMutationRequest(request);
    const user = requireRequestUser(request);
    const body = await readJsonObject(request);
    assertExactJsonKeys(
      body,
      [],
      "INVALID_LOBBY_HEARTBEAT",
      "Lobby heartbeats do not accept fields.",
    );
    return jsonResponse(await heartbeatLobbyPresence(user));
  } catch (error) {
    return routeErrorResponse(error);
  }
}

