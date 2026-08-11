import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.env.V11_BASE_URL ?? "http://localhost:3000";
const artifactDir =
  process.env.V11_ARTIFACT_DIR ?? "/tmp/open-shed-v11-acceptance";
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

await mkdir(artifactDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const errors = [];

try {
  const hostContext = await browser.newContext({
    viewport: { width: 1280, height: 820 },
  });
  const guestContext = await browser.newContext({
    viewport: { width: 320, height: 900 },
    reducedMotion: "reduce",
  });
  await installIdentity(hostContext, `v11-host-${runId}`, "V1.1 Host");
  await installIdentity(guestContext, `v11-guest-${runId}`, "V1.1 Guest");

  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  watchErrors(host, "host", errors);
  watchErrors(guest, "guest", errors);

  await host.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await host.getByRole("button", { name: "Create a table" }).click();
  const codeButton = host.getByRole("button", { name: /Copy table code/ });
  const joinCode = (await codeButton.innerText()).trim();
  assert.match(joinCode, /^[A-Z0-9]{6}$/);
  await host.screenshot({
    path: `${artifactDir}/01-host-lobby.png`,
    fullPage: true,
  });

  await guest.goto(`${baseUrl}/?join=${joinCode}`, {
    waitUntil: "domcontentloaded",
  });
  await guest.getByRole("dialog", { name: `Join table ${joinCode}?` }).waitFor();
  await guest.getByRole("button", { name: "Join this table" }).click();
  await guest.getByRole("button", { name: "I’m ready" }).waitFor();

  let droppedReadyResponse = false;
  await guest.route("**/commands", async (route) => {
    if (droppedReadyResponse) {
      await route.continue();
      return;
    }
    droppedReadyResponse = true;
    const committed = await route.fetch();
    await committed.body();
    await route.abort("failed");
  });
  await guest.getByRole("button", { name: "I’m ready" }).click();
  const retry = guest.getByRole("button", { name: "Retry saved action" });
  await retry.waitFor({ timeout: 8_000 });
  assert.equal(
    await guest.getByRole("button", { name: "I’m ready" }).isDisabled(),
    true,
    "a saved mutation must block a second room action",
  );
  await guest.unroute("**/commands");
  await retry.click();
  await guest.getByRole("button", { name: "Mark not ready" }).waitFor();

  await host
    .getByText("V1.1 Host still needs to ready up.", { exact: true })
    .first()
    .waitFor({ timeout: 8_000 });
  await host.getByRole("button", { name: "I’m ready" }).click();
  const startGame = host.getByRole("button", { name: "Start game" });
  await waitForEnabled(startGame, 8_000);
  await startGame.click();
  await guest.getByText("Your hand", { exact: true }).waitFor({ timeout: 8_000 });

  const mobileBounds = await guest.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert.equal(
    mobileBounds.scrollWidth,
    mobileBounds.clientWidth,
    "the 320px game view must not overflow the root viewport",
  );
  await guest.screenshot({
    path: `${artifactDir}/02-mobile-active-game.png`,
    fullPage: true,
  });

  await guestContext.setOffline(true);
  await guest
    .locator(".mobile-connection-note", { hasText: /Offline — action retry ready/ })
    .waitFor({ timeout: 4_000 });
  await guestContext.setOffline(false);
  await guest
    .locator(".mobile-connection-note", { hasText: /Live table|Reconnecting/ })
    .waitFor({ timeout: 8_000 });

  await host.getByRole("button", { name: "Rules & cards" }).click();
  await host.getByRole("dialog", { name: "Rules & action guide" }).waitFor();
  await host.keyboard.press("Escape");
  assert.equal(
    await host.getByRole("dialog", { name: "Rules & action guide" }).count(),
    0,
    "Escape must close the in-game rules dialog",
  );

  await hostContext.close();
  await guestContext.close();
} finally {
  await browser.close();
}

const expectedDroppedResponseErrors = errors.filter(
  (error) => error === "guest: console.error: Failed to load resource: net::ERR_FAILED",
);
assert.equal(
  expectedDroppedResponseErrors.length,
  1,
  "the simulated lost response should produce one expected browser network error",
);
const unexpectedErrors = errors.filter(
  (error) => error !== "guest: console.error: Failed to load resource: net::ERR_FAILED",
);
assert.deepEqual(
  unexpectedErrors,
  [],
  `unexpected browser errors: ${JSON.stringify(unexpectedErrors)}`,
);
process.stdout.write(
  `V1.1 browser acceptance passed. Artifacts: ${artifactDir}\n`,
);

async function installIdentity(context, id, name) {
  await context.addInitScript(
    ({ identityId, identityName }) => {
      localStorage.setItem(
        "open-shed-dev-identity",
        JSON.stringify({ id: identityId, name: identityName }),
      );
    },
    { identityId: id, identityName: name },
  );
}

function watchErrors(page, label, target) {
  page.on("pageerror", (error) => {
    target.push(`${label}: pageerror: ${String(error)}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      target.push(`${label}: console.error: ${message.text()}`);
    }
  });
}

async function waitForEnabled(locator, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await locator.isEnabled()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out after ${timeout}ms waiting for enabled control`);
}
