import {
  assertSafeMutationRequest,
  requireRequestUser,
} from "../../../../../lib/server/auth";
import { createLiveVoiceSession } from "../../../../../lib/server/live-voice-store";
import {
  assertExactJsonKeys,
} from "../../../../../lib/server/communication-policy";
import {
  jsonResponse,
  readJsonObject,
  routeErrorResponse,
} from "../../../../../lib/server/responses";

type RouteContext = { params: Promise<{ gameId: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSafeMutationRequest(request);
    const user = requireRequestUser(request);
    const { gameId } = await context.params;
    const body = await readJsonObject(request);
    assertExactJsonKeys(
      body,
      [],
      "INVALID_VOICE_SESSION",
      "Voice session requests do not accept additional fields.",
    );
    return jsonResponse(await createLiveVoiceSession(user, gameId));
  } catch (error) {
    return routeErrorResponse(error);
  }
}
