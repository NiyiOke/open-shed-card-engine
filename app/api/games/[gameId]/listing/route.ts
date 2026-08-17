import { GameRuleError } from "../../../../../lib/game/errors";
import {
  assertSafeMutationRequest,
  requireRequestUser,
} from "../../../../../lib/server/auth";
import {
  mutateGameListing,
  type ListingMutationInput,
} from "../../../../../lib/server/game-store";
import { parsePublicPace } from "../../../../../lib/server/discovery-policy";
import {
  jsonResponse,
  readJsonObject,
  requireCommandId,
  routeErrorResponse,
} from "../../../../../lib/server/responses";
import { reconcileLiveVoiceCleanupForGame } from "../../../../../lib/server/live-voice-cleanup";
import { notifyRealtimeChange } from "../../../../../lib/server/realtime-notify";

type RouteContext = { params: Promise<{ gameId: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSafeMutationRequest(request);
    const user = requireRequestUser(request);
    const { gameId } = await context.params;
    const body = await readJsonObject(request);
    const commandId = requireCommandId(body.commandId);
    const expectedRevision = readNonNegativeInteger(
      body.expectedRevision,
      "INVALID_REVISION",
      "expectedRevision must be a non-negative integer.",
    );
    const action = body.action;
    if (action !== "publish" && action !== "unpublish") {
      throw new GameRuleError(
        "INVALID_LISTING_ACTION",
        "action must be publish or unpublish.",
        400,
      );
    }
    const expectedListingVersion = body.expectedListingVersion;
    if (
      expectedListingVersion !== null &&
      (!Number.isSafeInteger(expectedListingVersion) ||
        (expectedListingVersion as number) < 0)
    ) {
      throw new GameRuleError(
        "INVALID_LISTING_VERSION",
        "expectedListingVersion must be null or a non-negative integer.",
        400,
      );
    }

    let input: ListingMutationInput;
    if (action === "publish") {
      if (typeof body.alias !== "string") {
        throw new GameRuleError(
          "INVALID_ALIAS",
          "Enter a room alias before publishing.",
          400,
        );
      }
      const pace = parsePublicPace(body.pace);
      if (!pace) {
        throw new GameRuleError(
          "INVALID_PACE",
          "pace must be casual or quick.",
          400,
        );
      }
      input = {
        action,
        alias: body.alias,
        pace,
        commandId,
        expectedRevision,
        expectedListingVersion: expectedListingVersion as number | null,
      };
    } else {
      if (!Number.isSafeInteger(expectedListingVersion)) {
        throw new GameRuleError(
          "INVALID_LISTING_VERSION",
          "Unpublishing requires the current listing version.",
          400,
        );
      }
      input = {
        action,
        commandId,
        expectedRevision,
        expectedListingVersion: expectedListingVersion as number,
      };
    }
    const result = await mutateGameListing(user, gameId, input);
    if (action === "publish") await reconcileLiveVoiceCleanupForGame(gameId);
    if (!result.replayed) {
      await notifyRealtimeChange(gameId, ["game", "chat"]);
    }
    return jsonResponse({ listing: result.listing, view: result.view });
  } catch (error) {
    return routeErrorResponse(error);
  }
}

function readNonNegativeInteger(
  value: unknown,
  code: string,
  message: string,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new GameRuleError(code, message, 400);
  }
  return value as number;
}
