const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  testMatch: /pages-smoke\.spec\.cjs/,
  timeout: 240_000,
  use: {
    baseURL: process.env.PAGES_URL,
    browserName: "chromium",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
});
