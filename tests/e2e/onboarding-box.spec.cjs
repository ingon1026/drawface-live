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

async function redBoxEdges(page) {
  return page.locator("#onboardCanvas").evaluate((canvas) => {
    const { data, width, height } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    const redAt = (x, y) => {
      const i = (y * width + x) * 4;
      return data[i] > 200 && data[i + 1] < 110 && data[i + 2] < 110;
    };
    const vertical = [];
    for (let x = 0; x < width; x++) {
      let start = -1;
      for (let y = 0; y < height; y++) {
        const red = redAt(x, y);
        if (red && start < 0) start = y;
        if ((!red || y === height - 1) && start >= 0) {
          const end = red && y === height - 1 ? y : y - 1;
          if (end - start >= 30) vertical.push({ x, top: start, bottom: end });
          start = -1;
        }
      }
    }
    if (!vertical.length) return null;
    return {
      left: Math.min(...vertical.map((line) => line.x)),
      right: Math.max(...vertical.map((line) => line.x)),
      top: Math.min(...vertical.map((line) => line.top)),
      bottom: Math.max(...vertical.map((line) => line.bottom)),
    };
  });
}

async function redPixelBounds(page) {
  return page.locator("#onboardCanvas").evaluate((canvas) => {
    const { data, width, height } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    let left = width, top = height, right = -1, bottom = -1;
    for (let y = 260; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (data[i] > 200 && data[i + 1] < 110 && data[i + 2] < 110) {
          left = Math.min(left, x); top = Math.min(top, y);
          right = Math.max(right, x); bottom = Math.max(bottom, y);
        }
      }
    }
    return right >= left ? { left, top, right, bottom } : null;
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

async function mouseDrag(page, canvas, from, to) {
  const start = pagePoint(canvas, from);
  const end = pagePoint(canvas, to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y);
  await page.mouse.up();
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

const CORNER_CASES = [
  {
    name: "top-left", from: (b) => ({ x: b.left - 4, y: b.top }),
    to: (b) => ({ x: b.left - 28, y: b.top - 18 }),
    check: (before, after) => {
      expect(after.left).toBeLessThan(before.left - 16);
      expect(after.top).toBeLessThan(before.top - 12);
      expectNear(after.right, before.right); expectNear(after.bottom, before.bottom);
    },
  },
  {
    name: "top-right", from: (b) => ({ x: b.right + 4, y: b.top }),
    to: (b) => ({ x: b.right + 28, y: b.top - 18 }),
    check: (before, after) => {
      expectNear(after.left, before.left); expect(after.top).toBeLessThan(before.top - 12);
      expect(after.right).toBeGreaterThan(before.right + 16); expectNear(after.bottom, before.bottom);
    },
  },
  {
    name: "bottom-left", from: (b) => ({ x: b.left - 4, y: b.bottom + 4 }),
    to: (b) => ({ x: b.left - 28, y: b.bottom + 22 }),
    check: (before, after) => {
      expect(after.left).toBeLessThan(before.left - 16); expectNear(after.top, before.top);
      expectNear(after.right, before.right); expect(after.bottom).toBeGreaterThan(before.bottom + 14);
    },
  },
];

for (const corner of CORNER_CASES) {
  test(`mouse drag resizes the ${corner.name} corner`, async ({ page }) => {
    const canvas = await openManualOnboarding(page);
    const initial = await redMouthBox(page);
    await mouseDrag(page, canvas, corner.from(initial), corner.to(initial));
    corner.check(initial, await redMouthBox(page));
  });
}

test("mouth box enforces its minimum size", async ({ page }) => {
  const canvas = await openManualOnboarding(page);
  const initial = await redMouthBox(page);
  await mouseDrag(page, canvas,
    { x: initial.right + 4, y: initial.bottom + 4 },
    { x: initial.left - 4, y: initial.top });
  // A 12px box plus its 4px handles is at least 20px wide/high in red pixels.
  const minimum = await redPixelBounds(page);
  expect(minimum.right - minimum.left).toBeGreaterThanOrEqual(19);
  expect(minimum.bottom - minimum.top).toBeGreaterThanOrEqual(19);
});

test("mouth box stays within canvas boundaries", async ({ page }) => {
  const canvas = await openManualOnboarding(page);
  const initial = await redMouthBox(page);
  await mouseDrag(page, canvas,
    { x: initial.left - 4, y: initial.top }, { x: -100, y: -100 });
  const atTopLeft = await redBoxEdges(page);
  expect(atTopLeft.left).toBeLessThanOrEqual(4);
  expect(atTopLeft.top).toBeLessThanOrEqual(4);
  await mouseDrag(page, canvas,
    { x: atTopLeft.right + 4, y: atTopLeft.bottom + 4 }, { x: 700, y: 700 });
  const atBottomRight = await redBoxEdges(page);
  expect(atBottomRight.right).toBeGreaterThanOrEqual(507);
  expect(atBottomRight.bottom).toBeGreaterThanOrEqual(507);
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
