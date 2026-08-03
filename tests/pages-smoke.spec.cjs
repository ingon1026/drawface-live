const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const pagesUrl = process.env.PAGES_URL;
const assetVersion = process.env.PAGES_ASSET_VERSION;

if (!pagesUrl || !assetVersion) {
  throw new Error("PAGES_URL and PAGES_ASSET_VERSION are required for the Pages smoke test");
}

// Pages 는 배포를 즉시 반영하지 않고, 신규 경로는 엣지에 404 가 캐시되기도 한다
// (docs/index.html 의 CDN 폴백 주석 — 실제로 당한 적 있는 실패 모드).
// 두 테스트 다 이 지연을 넘겨야 하므로 재시도를 한 곳에 둔다. 테스트별로 복붙하면
// 한쪽만 가진 상태가 되고, 그러면 뒤 테스트가 "앞 테스트가 기다려 준 덕에" 우연히
// 통과하는 선언되지 않은 순서 의존이 생긴다.
async function untilPagesCatchUp(label, attempt, { waitMs = 10_000, budgetMs = 210_000 } = {}) {
  const deadline = Date.now() + budgetMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw new Error(`${label}: Pages 가 ${budgetMs / 1000}초 안에 따라오지 못했습니다 — ${lastError?.message}`);
}

test("published GitHub Pages serves the current draw UI", async ({ page }) => {
  const drawUrl = new URL("draw.html", pagesUrl).toString();

  await untilPagesCatchUp("draw.html", async () => {
    const response = await page.goto(drawUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
    if (!response?.ok()) throw new Error(`draw.html returned HTTP ${response?.status()}`);

    await expect(page.locator("#startBtn")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("#perfMode")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("#trackerRetryBtn")).toBeAttached({ timeout: 5_000 });

    const mainScript = await page.locator('script[type="module"][src*="js/main.js"]').getAttribute("src");
    if (!mainScript?.includes(`v=${assetVersion}`)) {
      throw new Error(`expected asset version ${assetVersion}, received ${mainScript ?? "no main script"}`);
    }
  });
});

// 페이지 목록은 체크아웃에서 읽는다 — 페이지를 추가해도 이 파일은 안 고쳐도 된다.
const htmlPages = fs
  .readdirSync(path.join(__dirname, "..", "docs"))
  .filter((name) => name.endsWith(".html"))
  .sort();

// 마크업에 박힌 미디어만 본다. 대부분의 페이지는 0개이고(자원을 JS 로 로드한다) 그래도 통과해야
// 하므로 "미디어가 하나 이상"을 요구하지 않는다 — 지금 해당하는 건 illust.html 뿐이다.
// 페이지가 200 이어도 그 안의 미디어는 404 일 수 있어서, 응답 코드까지 따로 확인한다.
test(`published Pages serves all ${htmlPages.length} pages and their inline media`, async ({ page, request }) => {
  expect(htmlPages, "docs/*.html").not.toHaveLength(0);

  await untilPagesCatchUp("정적 페이지", async () => {
    for (const name of htmlPages) {
      const pageUrl = new URL(name, pagesUrl).toString();
      const response = await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
      if (response?.status() !== 200) throw new Error(`${name} returned HTTP ${response?.status()}`);

      // boy.html 은 meta refresh 리다이렉트 스텁이라, DOM 을 읽으려 하면 그 사이 이동이 일어나
      // "Execution context was destroyed" 로 터진다. 스텁은 200 을 확인한 것으로 충분하고,
      // 옮겨간 목적지는 그 목적지 차례에 어차피 검사된다.
      if (await page.locator('meta[http-equiv="refresh" i]').count()) continue;

      // el.src 는 브라우저가 이미 절대 URL 로 해석해 준다 — base URL 규칙을 손으로 재구현하지 않는다.
      const sources = await page
        .locator("video[src], img[src]")
        .evaluateAll((els) => els.map((el) => el.src));

      for (const src of sources) {
        const media = await request.get(src);
        if (media.status() !== 200) throw new Error(`${name} → ${src} returned HTTP ${media.status()}`);
      }
    }
  });
});
