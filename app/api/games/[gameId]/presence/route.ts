import { assertSafeMutationRequest, requireRequestUser } from "../../../../../lib/server/auth";
import {
  getGamePresence,
  heartbeatGamePresence,
} from "../../../../../lib/server/game-store";
import {
  jsonResponse,
  readJsonObject,
  routeErrorResponse,
} from "../../../../../lib/server/responses";
import { notifyRealtimeChange } from "../../../../../lib/server/realtime-notify";

type RouteContext = { params: Promise<{ gameId: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const user = requireRequestUser(request);
    const { gameId } = await context.params;
    return jsonResponse(await getGamePresence(user, gameId));
  } catch (error) {
    return routeErrorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSafeMutationRequest(request);
    const user = requireRequestUser(request);
    const { gameId } = await context.params;
    await readJsonObject(request);
    const result = await heartbeatGamePresence(user, gameId);
    await notifyRealtimeChange(gameId, ["game"]);
    return jsonResponse(result);
  } catch (error) {
    return routeErrorResponse(error);
  }
}
