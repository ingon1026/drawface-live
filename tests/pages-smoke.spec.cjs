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
