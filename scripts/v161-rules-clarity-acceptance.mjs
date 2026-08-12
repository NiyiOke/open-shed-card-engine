import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.env.V161_BASE_URL ?? "http://localhost:3121";
const publicUrl = process.env.V161_PUBLIC_URL ?? null;
const artifactDir =
  process.env.V161_ARTIFACT_DIR ??
  `/tmp/open-shed-v161-rules-clarity-${Date.now()}`;

await mkdir(artifactDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const browserErrors = [];

try {
  const desktopContext = await browser.newContext({
    viewport: { width: 1280, height: 820 },
  });
  const mobileContext = await browser.newContext({
    viewport: { width: 320, height: 900 },
    reducedMotion: "reduce",
  });
  await installIdentity(desktopContext, "v161-rules-desktop", "Rules Desktop");
  await installIdentity(mobileContext, "v161-rules-mobile", "Rules Mobile");

  const desktop = await desktopContext.newPage();
  const mobile = await mobileContext.newPage();
  watchErrors(desktop, "desktop", browserErrors);
  watchErrors(mobile, "mobile", browserErrors);

  await desktop.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await desktop.getByRole("button", { name: "Rules and cards" }).waitFor();
  await desktop.getByRole("button", { name: "Rules and cards" }).click();
  const desktopDialog = desktop.getByRole("dialog", { name: "Rules & cards" });
  await desktopDialog.waitFor();
  assert.equal(
    await desktop.getByRole("button", { name: "Close rules guide" }).evaluate(
      (element) => element === document.activeElement,
    ),
    true,
    "the guide must initially focus its early close action",
  );
  await assertGuideContent(desktop);
  await desktop.getByRole("link", { name: "Deck inventory" }).click();
  assert.equal(
    await desktop.getByRole("heading", { name: "168-card inventory" }).evaluate(
      (element) => element === document.activeElement,
    ),
    true,
    "TOC links must focus their destination headings",
  );
  await desktop.screenshot({
    path: `${artifactDir}/01-rules-desktop.png`,
    fullPage: false,
  });
  await desktop.keyboard.press("Escape");
  assert.equal(await desktopDialog.count(), 0);
  await desktop.waitForFunction(() =>
    document.activeElement?.getAttribute("aria-label") === "Rules and cards",
  );
  assert.equal(
    await desktop.getByRole("button", { name: "Rules and cards" }).evaluate(
      (element) => element === document.activeElement,
    ),
    true,
    "Escape must restore the exact rules trigger",
  );

  await mobile.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await mobile.getByRole("button", { name: "Rules and cards" }).waitFor();
  await mobile.getByRole("button", { name: "Rules and cards" }).click();
  const mobileDialog = mobile.getByRole("dialog", { name: "Rules & cards" });
  await mobileDialog.waitFor();
  await assertGuideContent(mobile);
  await assertNoHorizontalOverflow(mobile, "320px rules guide");
  await assertTargets(mobile);
  await mobile.screenshot({
    path: `${artifactDir}/02-rules-mobile-320.png`,
    fullPage: false,
  });

  await mobile.setViewportSize({ width: 640, height: 900 });
  await mobile.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await assertNoHorizontalOverflow(mobile, "200 percent zoom rules guide");
  await mobile.screenshot({
    path: `${artifactDir}/03-rules-200-percent.png`,
    fullPage: false,
  });

  const semanticState = JSON.parse(
    await desktop.evaluate(() => window.render_game_to_text?.() ?? "{}"),
  );
  assert.equal(semanticState.release?.appVersion, "1.6.1");

  if (publicUrl) {
    const publicContext = await browser.newContext({
      viewport: { width: 320, height: 900 },
      reducedMotion: "reduce",
    });
    const publicPage = await publicContext.newPage();
    watchErrors(publicPage, "public", browserErrors);
    await publicPage.goto(`${publicUrl}/#action-cards`, {
      waitUntil: "domcontentloaded",
    });
    await publicPage.getByRole("heading", { name: "Know what hits the table." }).waitFor();
    await publicPage.getByRole("heading", { name: "168-card inventory" }).waitFor();
    assert.equal(await publicPage.locator(".rules-guide-card").count(), 10);
    await publicPage.getByRole("heading", { name: "Know what hits the table." }).scrollIntoViewIfNeeded();
    await assertNoHorizontalOverflow(publicPage, "320px public rulebook");
    await publicPage.screenshot({
      path: `${artifactDir}/04-public-rules-mobile-320.png`,
      fullPage: false,
    });
    await publicContext.close();
  }

  assert.deepEqual(browserErrors, []);

  await desktopContext.close();
  await mobileContext.close();
} finally {
  await browser.close();
}

process.stdout.write(`V1.6.1 rules-clarity acceptance passed: ${artifactDir}\n`);

async function assertGuideContent(page) {
  await page.getByRole("heading", { name: "How a round works" }).waitFor();
  await page.getByRole("heading", { name: "Action card guide" }).waitFor();
  await page.getByRole("heading", { name: "168-card inventory" }).waitFor();
  await page.getByRole("heading", { name: "Round wins, not card points" }).waitFor();
  assert.equal(await page.locator(".rules-guide-card").count(), 10);
  assert.equal(await page.locator(".rules-deck-inventory > div").count(), 12);
  await page.getByText("Complete core deck").waitFor();
  await page.getByText("168 cards", { exact: true }).waitFor();
  await page.getByText("Not enabled", { exact: true }).waitFor();
}

async function assertTargets(page) {
  const targets = await page.locator(
    ".rules-guide-close, .rules-guide-toc a",
  ).evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { width: box.width, height: box.height, text: element.textContent?.trim() };
    }),
  );
  assert.ok(targets.length >= 5);
  for (const target of targets) {
    assert.ok(target.height >= 44, `${target.text} must be at least 44px tall`);
  }
}

async function assertNoHorizontalOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert.equal(dimensions.scrollWidth, dimensions.clientWidth, `${label} overflowed`);
}

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
  page.on("pageerror", (error) => target.push(`${label}: ${String(error)}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      target.push(`${label}: ${message.text()}`);
    }
  });
}
