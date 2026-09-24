import { GameRuleError } from "../../../lib/game/errors";
import {
  assertSafeMutationRequest,
  requireRequestUser,
} from "../../../lib/server/auth";
import { assertExactJsonKeys } from "../../../lib/server/communication-policy";
import {
  getLobbyPresence,
  setLobbyPresence,
} from "../../../lib/server/lobby-presence-store";
import {
  jsonResponse,
  readJsonObject,
  requireCommandId,
  routeErrorResponse,
} from "../../../lib/server/responses";

export async function GET(request: Request) {
  try {
    const user = requireRequestUser(request);
    return jsonResponse(await getLobbyPresence(user));
  } catch (error) {
    return routeErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    assertSafeMutationRequest(request);
    const user = requireRequestUser(request);
    const body = await readJsonObject(request);
    const commandId = requireCommandId(body.commandId);
    if (body.lookingForGame === true) {
      assertExactJsonKeys(
        body,
        ["commandId", "lookingForGame", "alias"],
        "INVALID_LOBBY_PRESENCE",
        "Opting in requires only commandId, lookingForGame, and alias.",
      );
      if (typeof body.alias !== "string") {
        throw new GameRuleError("INVALID_ALIAS", "Enter a public lobby alias.", 400);
      }
      return jsonResponse(
        await setLobbyPresence(user, {
          commandId,
          lookingForGame: true,
          alias: body.alias,
        }),
      );
    }
    if (body.lookingForGame === false) {
      assertExactJsonKeys(
        body,
        ["commandId", "lookingForGame"],
        "INVALID_LOBBY_PRESENCE",
        "Opting out requires only commandId and lookingForGame.",
      );
      return jsonResponse(
        await setLobbyPresence(user, { commandId, lookingForGame: false }),
      );
    }
    throw new GameRuleError(
      "INVALID_LOBBY_PRESENCE",
      "lookingForGame must be true or false.",
      400,
    );
  } catch (error) {
    return routeErrorResponse(error);
  }
}

