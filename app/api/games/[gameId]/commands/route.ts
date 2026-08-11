import { parseGameCommand } from "../../../../../lib/server/command-parser";
import { GameRuleError } from "../../../../../lib/game/errors";
import { assertSafeMutationRequest, requireRequestUser } from "../../../../../lib/server/auth";
import { executeGameCommand } from "../../../../../lib/server/game-store";
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
    const { gameId } = await context.params;
    const body = await readJsonObject(request);
    const commandId = requireCommandId(body.commandId);
    const expectedRevision = body.expectedRevision;
    if (
      typeof expectedRevision !== "number" ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0
    ) {
      throw new GameRuleError(
        "INVALID_REVISION",
        "expectedRevision must be a non-negative integer.",
        400,
      );
    }
    const command = parseGameCommand(body.command);
    const result = await executeGameCommand(
      user,
      gameId,
      expectedRevision,
      commandId,
      command,
    );
    return jsonResponse(result);
  } catch (error) {
    return routeErrorResponse(error);
  }
}
