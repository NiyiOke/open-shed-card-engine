import { GameRuleError } from "../game/errors";
import { COLORS, type CardColor, type GameCommand } from "../game/types";

export function parseGameCommand(value: unknown): GameCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GameRuleError("INVALID_COMMAND", "command must be an object.", 400);
  }
  const input = value as Record<string, unknown>;
  if (typeof input.type !== "string") {
    throw new GameRuleError("INVALID_COMMAND", "command.type is required.", 400);
  }

  switch (input.type) {
    case "set_ready":
      return { type: "set_ready", ready: requireBoolean(input.ready, "ready") };
    case "start_game":
      return { type: "start_game" };
    case "play_card":
      return {
        type: "play_card",
        cardId: requireShortString(input.cardId, "cardId", 100),
        chosenColor:
          input.chosenColor === undefined
            ? undefined
            : requireColor(input.chosenColor),
        swapTargetId:
          input.swapTargetId === undefined
            ? undefined
            : requireShortString(input.swapTargetId, "swapTargetId", 100),
        declareUno:
          input.declareUno === undefined
            ? undefined
            : requireBoolean(input.declareUno, "declareUno"),
      };
    case "draw_until_playable":
      return { type: "draw_until_playable" };
    case "accept_penalty":
      return { type: "accept_penalty" };
    case "choose_roulette_color":
      return {
        type: "choose_roulette_color",
        color: requireColor(input.color),
      };
    case "declare_uno":
      return { type: "declare_uno" };
    case "catch_uno":
      return {
        type: "catch_uno",
        offenderPlayerId: requireShortString(
          input.offenderPlayerId,
          "offenderPlayerId",
          100,
        ),
      };
    case "leave_game":
      return { type: "leave_game" };
    default:
      throw new GameRuleError(
        "UNSUPPORTED_COMMAND",
        `Unsupported command type: ${input.type}`,
        400,
      );
  }
}

function requireColor(value: unknown): CardColor {
  if (typeof value !== "string" || !COLORS.includes(value as CardColor)) {
    throw new GameRuleError("INVALID_COLOR", "Choose red, yellow, green, or blue.", 400);
  }
  return value as CardColor;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new GameRuleError("INVALID_FIELD", `${field} must be a boolean.`, 400);
  }
  return value;
}

function requireShortString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new GameRuleError(
      "INVALID_FIELD",
      `${field} must be a non-empty string no longer than ${maxLength} characters.`,
      400,
    );
  }
  return value;
}
