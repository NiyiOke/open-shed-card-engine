import { getPublicAvailability } from "../../../../lib/server/game-store";
import { PUBLIC_DISCOVERY_CACHE_SECONDS } from "../../../../lib/server/discovery-policy";
import { routeErrorResponse } from "../../../../lib/server/responses";

export async function GET() {
  try {
    const availability = await getPublicAvailability();
    return Response.json(availability, {
      headers: {
        "cache-control": `public, max-age=${PUBLIC_DISCOVERY_CACHE_SECONDS}, s-maxage=${PUBLIC_DISCOVERY_CACHE_SECONDS}, stale-while-revalidate=${PUBLIC_DISCOVERY_CACHE_SECONDS}`,
      },
    });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
