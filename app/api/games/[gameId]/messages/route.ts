import { GameRuleError } from "../../../../../lib/game/errors";
import {
  assertSafeMutationRequest,
  requireRequestUser,
} from "../../../../../lib/server/auth";
import {
  listTableMessages,
  sendTableMessage,
} from "../../../../../lib/server/chat-store";
import {
  assertCommunicationEnabled,
  assertExactJsonKeys,
  hasRecognizedFreeTextField,
  parseCommunicationMessage,
  requireOpaqueCommunicationId,
} from "../../../../../lib/server/communication-policy";
import {
  jsonResponse,
  readJsonObject,
  requireCommandId,
  routeErrorResponse,
} from "../../../../../lib/server/responses";

type RouteContext = { params: Promise<{ gameId: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const user = requireRequestUser(request);
    assertCommunicationEnabled();
    const { gameId } = await context.params;
    const searchParams = new URL(request.url).searchParams;
    const keys = [...searchParams.keys()];
    if (keys.some((key) => key !== "cursor") || searchParams.getAll("cursor").length > 1) {
      throw new GameRuleError(
        "INVALID_MESSAGE_CURSOR",
        "Only one opaque message cursor is accepted.",
        400,
      );
    }
    const rawCursor = searchParams.get("cursor");
    const cursor = rawCursor === null
      ? null
      : requireOpaqueCommunicationId(
          rawCursor,
          "INVALID_MESSAGE_CURSOR",
          "The message cursor is invalid.",
        );
    return jsonResponse(await listTableMessages(user, gameId, cursor));
  } catch (error) {
    return routeErrorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSafeMutationRequest(request);
    const user = requireRequestUser(request);
    assertCommunicationEnabled();
    const { gameId } = await context.params;
    const body = await readJsonObject(request);
    if (
      hasRecognizedFreeTextField(body, ["commandId", "kind", "contentId"])
    ) {
      throw new GameRuleError(
        "FREE_TEXT_DISABLED",
        "Free-text table messages are not available.",
        400,
      );
    }
    assertExactJsonKeys(
      body,
      ["commandId", "kind", "contentId"],
      "INVALID_MESSAGE",
      "Send exactly one available phrase or reaction.",
    );
    const commandId = requireCommandId(body.commandId);
    const message = parseCommunicationMessage(body.kind, body.contentId);
    return jsonResponse(
      await sendTableMessage(
        user,
        gameId,
        commandId,
        message.kind,
        message.contentId,
      ),
    );
  } catch (error) {
    return routeErrorResponse(error);
  }
}
