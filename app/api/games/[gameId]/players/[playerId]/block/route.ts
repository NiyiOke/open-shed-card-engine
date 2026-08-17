import { GameRuleError } from "../../../../../../../lib/game/errors";
import {
  assertSafeMutationRequest,
  requireRequestUser,
} from "../../../../../../../lib/server/auth";
import { setProfileBlock } from "../../../../../../../lib/server/chat-store";
import {
  assertCommunicationEnabled,
  assertExactJsonKeys,
} from "../../../../../../../lib/server/communication-policy";
import {
  jsonResponse,
  readJsonObject,
  routeErrorResponse,
} from "../../../../../../../lib/server/responses";

type RouteContext = {
  params: Promise<{ gameId: string; playerId: string }>;
};

export async function PUT(request: Request, context: RouteContext) {
  return mutateBlock(request, context, true);
}

export async function DELETE(request: Request, context: RouteContext) {
  return mutateBlock(request, context, false);
}

async function mutateBlock(
  request: Request,
  context: RouteContext,
  blocked: boolean,
) {
  try {
    assertSafeMutationRequest(request);
    const user = requireRequestUser(request);
    assertCommunicationEnabled();
    const { gameId, playerId } = await context.params;
    requirePlayerId(playerId);
    const body = await readJsonObject(request);
    assertExactJsonKeys(
      body,
      [],
      "INVALID_SAFETY_ACTION",
      "Block requests do not accept additional fields.",
    );
    const result = await setProfileBlock(user, gameId, playerId, blocked);
    return jsonResponse(result);
  } catch (error) {
    return routeErrorResponse(error);
  }
}

function requirePlayerId(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) {
    throw new GameRuleError(
      "INVALID_PLAYER_ID",
      "The player identifier is invalid.",
      400,
    );
  }
}
