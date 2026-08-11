import { getOptionalPublicDiscoveryUser } from "../../../../lib/server/auth";
import { listPublicRooms } from "../../../../lib/server/game-store";
import { jsonResponse, routeErrorResponse } from "../../../../lib/server/responses";

export async function GET(request: Request) {
  try {
    const user = getOptionalPublicDiscoveryUser(request);
    const cursor = new URL(request.url).searchParams.get("cursor");
    return jsonResponse(await listPublicRooms(user, cursor));
  } catch (error) {
    return routeErrorResponse(error);
  }
}
