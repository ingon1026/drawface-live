const { test, expect } = require("@playwright/test");

function pagePoint(canvas, point) {
  return {
    x: canvas.x + point.x * canvas.width / 512,
    y: canvas.y + point.y * canvas.height / 512,
  };
}

async function redMouthBox(page) {
  return page.locator("#onboardCanvas").evaluate((canvas) => {
    const { data, width, height } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    const lines = [];
    for (let y = 260; y < height; y++) {
      let runStart = -1;
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const red = data[i] > 200 && data[i + 1] < 110 && data[i + 2] < 110;
        if (red && runStart < 0) runStart = x;
        if ((!red || x === width - 1) && runStart >= 0) {
          const end = red && x === width - 1 ? x : x - 1;
          if (end - runStart >= 30) lines.push({ y, left: runStart, right: end });
          runStart = -1;
        }
      }
    }
    if (!lines.length) return null;
    const top = lines[0], bottom = lines.at(-1);
    return {
      left: Math.min(top.left, bottom.left), top: top.y,
      right: Math.max(top.right, bottom.right), bottom: bottom.y,
    };
  });
}

async function openManualOnboarding(page) {
  await page.route(/https:\/\/(cdn\.jsdelivr\.net|storage\.googleapis\.com)\//, (route) => route.abort());
  await page.goto("/draw.html");
  // Use the same PNG decode path as real uploads. SVG is not consistently
  // supported by createImageBitmap across the Chromium versions used in CI.
  await page.locator("#fileInput").setInputFiles("docs/characters/boy/base.png");
  await expect(page.locator("#onboardDlg")).toBeVisible();
  await expect(page.locator("#onboardStatus")).toContainText("클릭 1/4");
  const canvas = await page.locator("#onboardCanvas").boundingBox();
  if (!canvas) throw new Error("onboarding canvas is not visible");
  for (const point of [{ x: 166, y: 190 }, { x: 346, y: 190 }, { x: 200, y: 295 }, { x: 320, y: 345 }]) {
    const at = pagePoint(canvas, point);
    await page.mouse.click(at.x, at.y);
  }
  await expect(page.locator("#onboardStatus")).toContainText("모서리로 크기 조절");
  // showModal() centres the dialog. The longer post-click help text can change
  // its height, so capture the canvas position again before drag coordinates.
  const settledCanvas = await page.locator("#onboardCanvas").boundingBox();
  if (!settledCanvas) throw new Error("onboarding canvas moved out of view");
  return settledCanvas;
}

function expectNear(actual, expected, tolerance = 3) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

test("mouth box resizes from a corner and moves from its interior", async ({ page }) => {
  const canvas = await openManualOnboarding(page);
  const initial = await redMouthBox(page);
  expect(initial).not.toBeNull();

  // The handle fill obscures part of the red outline, so use the unambiguous
  // bottom-right corner to exercise actual mouse resizing.
  const se = pagePoint(canvas, { x: initial.right + 4, y: initial.bottom + 4 });
  const resizedTo = pagePoint(canvas, { x: initial.right + 32, y: initial.bottom + 22 });
  await page.mouse.move(se.x, se.y);
  await page.mouse.down();
  await page.mouse.move(resizedTo.x, resizedTo.y);
  await page.mouse.up();
  const resized = await redMouthBox(page);
  expectNear(resized.left, initial.left);
  expectNear(resized.top, initial.top);
  expect(resized.right).toBeGreaterThan(initial.right + 20);
  expect(resized.bottom).toBeGreaterThan(initial.bottom + 14);

  const center = { x: (resized.left + resized.right) / 2, y: (resized.top + resized.bottom) / 2 };
  const from = pagePoint(canvas, center);
  const to = pagePoint(canvas, { x: center.x + 32, y: center.y + 20 });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y);
  await page.mouse.up();
  const moved = await redMouthBox(page);
  expectNear(moved.left - resized.left, 32);
  expectNear(moved.top - resized.top, 20);
  expectNear(moved.right - resized.right, 32);
  expectNear(moved.bottom - resized.bottom, 20);
});

test("touch drag resizes the mouth box", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 900, height: 800 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const canvas = await openManualOnboarding(page);
  const initial = await redMouthBox(page);
  const cdp = await context.newCDPSession(page);
  const from = pagePoint(canvas, { x: initial.right, y: initial.bottom });
  const to = pagePoint(canvas, { x: initial.right + 28, y: initial.bottom + 22 });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: to.x, y: to.y, id: 1 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const resized = await redMouthBox(page);
  expectNear(resized.left, initial.left);
  expectNear(resized.top, initial.top);
  expect(resized.right).toBeGreaterThan(initial.right + 18);
  expect(resized.bottom).toBeGreaterThan(initial.bottom + 14);
  await context.close();
});
