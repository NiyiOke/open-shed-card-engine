import { chatGPTSignInPath, getChatGPTUser } from "./chatgpt-auth";
import { GameShell } from "./components/GameShell";
import { normalizePublicListingId } from "./components/public-discovery";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getChatGPTUser();
  const params = await searchParams;
  const linkedGameId = typeof params.game === "string" ? params.game : null;
  const linkedJoinCode =
    typeof params.join === "string" && /^[a-z0-9]{6}$/i.test(params.join)
      ? params.join.toUpperCase()
      : null;
  const linkedListingId = normalizePublicListingId(params.listing);
  const returnTo = linkedGameId
    ? `/?game=${encodeURIComponent(linkedGameId)}`
    : linkedJoinCode
      ? `/?join=${encodeURIComponent(linkedJoinCode)}`
      : linkedListingId
        ? `/?listing=${encodeURIComponent(linkedListingId)}`
        : "/";
  return (
    <GameShell
      signInPath={chatGPTSignInPath(returnTo)}
      initialSession={
        user
          ? { signedIn: true, displayName: user.fullName ?? "Player", development: false }
          : null
      }
    />
  );
}
