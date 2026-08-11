import { getChatGPTUser } from "./chatgpt-auth";
import { GameShell } from "./components/GameShell";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getChatGPTUser();
  return (
    <GameShell
      initialSession={
        user
          ? { signedIn: true, displayName: user.fullName ?? "Player", development: false }
          : null
      }
    />
  );
}
