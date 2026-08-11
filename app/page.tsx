import { chatGPTSignInPath, getChatGPTUser } from "./chatgpt-auth";
import { GameShell } from "./components/GameShell";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getChatGPTUser();
  const params = await searchParams;
  const linkedGameId = typeof params.game === "string" ? params.game : null;
  const returnTo = linkedGameId ? `/?game=${encodeURIComponent(linkedGameId)}` : "/";
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
