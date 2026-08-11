import { requireRequestUser } from "../../../../lib/server/auth";
import { GameRuleError } from "../../../../lib/game/errors";
import { getGame } from "../../../../lib/server/game-store";
import { jsonResponse, routeErrorResponse } from "../../../../lib/server/responses";

type RouteContext = { params: Promise<{ gameId: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const user = requireRequestUser(request);
    const { gameId } = await context.params;
    const rawAfterRevision = new URL(request.url).searchParams.get("afterRevision");
    let afterRevision: number | undefined;
    if (rawAfterRevision !== null) {
      afterRevision = Number(rawAfterRevision);
      if (
        !/^\d+$/.test(rawAfterRevision) ||
        !Number.isSafeInteger(afterRevision) ||
        afterRevision < 0
      ) {
        throw new GameRuleError(
          "INVALID_EVENT_CURSOR",
          "afterRevision must be a non-negative integer.",
          400,
        );
      }
    }
    return jsonResponse(await getGame(user, gameId, afterRevision));
  } catch (error) {
    return routeErrorResponse(error);
  }
}
