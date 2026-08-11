import { assertSafeMutationRequest, requireRequestUser } from "../../../../lib/server/auth";
import { joinGame } from "../../../../lib/server/game-store";
import { GameRuleError } from "../../../../lib/game/errors";
import {
  jsonResponse,
  readJsonObject,
  requireCommandId,
  routeErrorResponse,
} from "../../../../lib/server/responses";

export async function POST(request: Request) {
  try {
    assertSafeMutationRequest(request);
    const user = requireRequestUser(request);
    const body = await readJsonObject(request);
    const commandId = requireCommandId(body.commandId);
    if (typeof body.joinCode !== "string") {
      throw new GameRuleError("INVALID_JOIN_CODE", "joinCode is required.", 400);
    }
    const nickname =
      typeof body.nickname === "string" ? body.nickname : user.suggestedName;
    const view = await joinGame(user, nickname, body.joinCode, commandId);
    return jsonResponse({ view });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
