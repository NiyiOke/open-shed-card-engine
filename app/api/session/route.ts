import { getOptionalRequestUser } from "../../../lib/server/auth";
import { jsonResponse, routeErrorResponse } from "../../../lib/server/responses";

export async function GET(request: Request) {
  try {
    const user = getOptionalRequestUser(request);
    return jsonResponse({
      signedIn: Boolean(user),
      user: user
        ? {
            displayName: user.suggestedName,
            development: user.development,
          }
        : null,
    });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
