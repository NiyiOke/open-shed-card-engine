import {
  assertSafeMutationRequest,
  requireRequestUser,
} from "../../../../../lib/server/auth";
import { assertExactJsonKeys } from "../../../../../lib/server/communication-policy";
import { getGame } from "../../../../../lib/server/game-store";
import {
  getRealtimeConfig,
  issueRealtimeTicket,
} from "../../../../../lib/server/realtime-ticket";
import { enforceRealtimeTicketQuota } from "../../../../../lib/server/realtime-ticket-store";
import {
  jsonResponse,
  readJsonObject,
  routeErrorResponse,
} from "../../../../../lib/server/responses";

type RouteContext = { params: Promise<{ gameId: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSafeMutationRequest(request);
    const config = getRealtimeConfig();
    if (!config) return jsonResponse({ enabled: false });
    const user = requireRequestUser(request);
    const { gameId } = await context.params;
    const body = await readJsonObject(request);
    assertExactJsonKeys(
      body,
      [],
      "INVALID_REALTIME_TICKET",
      "Real-time connection requests do not accept additional fields.",
    );
    // This is deliberately the same authoritative membership and room-lifecycle
    // read used by polling. No Sites identity header is forwarded to the
    // companion service.
    await getGame(user, gameId);
    await enforceRealtimeTicketQuota(user.userId, gameId);
    return jsonResponse(await issueRealtimeTicket(config, {
      gameId,
      authSubject: user.userId,
    }));
  } catch (error) {
    return routeErrorResponse(error);
  }
}
