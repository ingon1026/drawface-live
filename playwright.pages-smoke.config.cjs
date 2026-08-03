const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  testMatch: /pages-smoke\.spec\.cjs/,
  timeout: 240_000,
  // 배포된 실물을 치는 테스트라 일시적 네트워크 요동 하나로 가짜 빨간불이 난다.
  // 테스트 안의 재시도는 Pages 전파 지연용이고, 이건 그 바깥의 그물이다 (playwright.config.cjs 와 동일).
  retries: 1,
  use: {
    baseURL: process.env.PAGES_URL,
    browserName: "chromium",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
});
