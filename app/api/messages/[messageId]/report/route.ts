import { GameRuleError } from "../../../../../lib/game/errors";
import {
  assertSafeMutationRequest,
  requireRequestUser,
} from "../../../../../lib/server/auth";
import { reportTableMessage } from "../../../../../lib/server/chat-store";
import {
  assertCommunicationEnabled,
  assertExactJsonKeys,
  hasRecognizedFreeTextField,
  parseReportReason,
  requireOpaqueCommunicationId,
} from "../../../../../lib/server/communication-policy";
import {
  jsonResponse,
  readJsonObject,
  requireCommandId,
  routeErrorResponse,
} from "../../../../../lib/server/responses";

type RouteContext = { params: Promise<{ messageId: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSafeMutationRequest(request);
    const user = requireRequestUser(request);
    assertCommunicationEnabled();
    const { messageId: rawMessageId } = await context.params;
    const messageId = requireOpaqueCommunicationId(
      rawMessageId,
      "INVALID_MESSAGE_ID",
      "The message identifier is invalid.",
    );
    const body = await readJsonObject(request);
    if (hasRecognizedFreeTextField(body, ["commandId", "reason"])) {
      throw new GameRuleError(
        "FREE_TEXT_DISABLED",
        "Reports do not accept free-text details.",
        400,
      );
    }
    assertExactJsonKeys(
      body,
      ["commandId", "reason"],
      "INVALID_REPORT",
      "Choose one available report reason.",
    );
    const commandId = requireCommandId(body.commandId);
    const reason = parseReportReason(body.reason);
    return jsonResponse(
      await reportTableMessage(user, messageId, commandId, reason),
    );
  } catch (error) {
    return routeErrorResponse(error);
  }
}
