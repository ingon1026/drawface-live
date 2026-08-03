const { test, expect } = require("@playwright/test");

const pagesUrl = process.env.PAGES_URL;
const assetVersion = process.env.PAGES_ASSET_VERSION;

if (!pagesUrl || !assetVersion) {
  throw new Error("PAGES_URL and PAGES_ASSET_VERSION are required for the Pages smoke test");
}

const drawUrl = new URL("draw.html", pagesUrl).toString();

test("published GitHub Pages serves the current draw UI", async ({ page }) => {
  const deadline = Date.now() + 210_000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await page.goto(drawUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
      if (!response?.ok()) throw new Error(`draw.html returned HTTP ${response?.status()}`);

      await expect(page.locator("#startBtn")).toBeVisible({ timeout: 5_000 });
      await expect(page.locator("#perfMode")).toBeVisible({ timeout: 5_000 });
      await expect(page.locator("#trackerRetryBtn")).toBeAttached({ timeout: 5_000 });

      const mainScript = await page.locator('script[type="module"][src*="js/main.js"]').getAttribute("src");
      if (!mainScript?.includes(`v=${assetVersion}`)) {
        throw new Error(`expected asset version ${assetVersion}, received ${mainScript ?? "no main script"}`);
      }
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(10_000);
    }
  }

  throw new Error(`GitHub Pages did not serve the current draw UI within 210 seconds: ${lastError?.message}`);
});

// illust.html 은 JS 없는 정적 쇼케이스라 실패 모드가 하나뿐이다 — 배포 후 미디어가 404.
// 페이지만 200 이면 통과해 버리므로 <video>/<img> 의 실제 응답 코드까지 본다.
test("published Pages serves the illustration showcase with its media", async ({ page, request }) => {
  const illustUrl = new URL("illust.html", pagesUrl).toString();
  const response = await page.goto(illustUrl, { waitUntil: "domcontentloaded" });
  expect(response?.status(), "illust.html").toBe(200);

  const sources = await page.locator("video[src], img[src]").evaluateAll(
    (els) => els.map((el) => el.getAttribute("src")),
  );
  expect(sources.length, "showcase media elements").toBeGreaterThan(0);

  for (const src of sources) {
    const mediaUrl = new URL(src, illustUrl).toString();
    const media = await request.get(mediaUrl);
    expect(media.status(), src).toBe(200);
  }
});
