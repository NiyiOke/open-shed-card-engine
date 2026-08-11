import { assertSafeMutationRequest, requireRequestUser } from "../../../lib/server/auth";
import { createGame, listLobbies } from "../../../lib/server/game-store";
import {
  jsonResponse,
  readJsonObject,
  requireCommandId,
  routeErrorResponse,
} from "../../../lib/server/responses";

export async function GET(request: Request) {
  try {
    const user = requireRequestUser(request);
    return jsonResponse(await listLobbies(user));
  } catch (error) {
    return routeErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSafeMutationRequest(request);
    const user = requireRequestUser(request);
    const body = await readJsonObject(request);
    const commandId = requireCommandId(body.commandId);
    const nickname =
      typeof body.nickname === "string" ? body.nickname : user.suggestedName;
    const view = await createGame(user, nickname, commandId);
    return jsonResponse({ view }, 201);
  } catch (error) {
    return routeErrorResponse(error);
  }
}
