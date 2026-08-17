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
  assertFreeTextEnabled,
  hasRecognizedFreeTextField,
  parseCommunicationMessage,
  parseFreeTextMessage,
  requireOpaqueCommunicationId,
} from "../../../../../lib/server/communication-policy";
import {
  jsonResponse,
  readJsonObject,
  requireCommandId,
  routeErrorResponse,
} from "../../../../../lib/server/responses";
import { notifyRealtimeChange } from "../../../../../lib/server/realtime-notify";

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
    const result = await listTableMessages(user, gameId, cursor);
    const response = jsonResponse(result.page);
    if (result.cursorRebased) {
      // Keep the privacy-reviewed JSON DTO byte-for-byte compatible while
      // explicitly telling reconnecting/new clients that an expired or
      // foreign opaque cursor was rebased to the latest bounded window.
      response.headers.set("X-Open-Shed-Chat-Cursor", "rebased");
    }
    return response;
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
    const commandId = requireCommandId(body.commandId);
    if (body.kind === "text") {
      assertFreeTextEnabled();
      assertExactJsonKeys(
        body,
        ["commandId", "kind", "body"],
        "INVALID_MESSAGE",
        "Send exactly one private-table text message.",
      );
      const sent = await sendTableMessage(
        user,
        gameId,
        commandId,
        parseFreeTextMessage(body.body),
      );
      if (!sent.replayed) await notifyRealtimeChange(gameId, ["chat"]);
      return jsonResponse(sent);
    }
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
    const message = parseCommunicationMessage(body.kind, body.contentId);
    const sent = await sendTableMessage(user, gameId, commandId, message);
    if (!sent.replayed) await notifyRealtimeChange(gameId, ["chat"]);
    return jsonResponse(sent);
  } catch (error) {
    return routeErrorResponse(error);
  }
}
