// Character persistence in localStorage as {name, manifest, images:{file:dataURL}}.
// ponytail: localStorage caps around 5-10MB (~a handful of characters); move to
// IndexedDB if users hit the ceiling.
const KEY = "drawface.characters";

function readAll() {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; }
}

export function listCharacters() {
  return Object.keys(readAll()).sort();
}

// Derived sprites (visemes, half-eyes, smile) are deterministic re-derivations
// of the core set — compositor.js rebuilds them at load, so storing them would
// only multiply the localStorage footprint.
const CORE_FILES = new Set(["base.png", "eye_L_open.png", "eye_R_open.png",
  "eye_L_closed.png", "eye_R_closed.png", "mouth_closed.png", "source.png"]);

export function saveCharacter(name, manifest, canvases) {
  const all = readAll();
  const images = {};
  for (const [file, canvas] of Object.entries(canvases)) {
    if (manifest.proceduralMouth && !CORE_FILES.has(file)) continue;
    images[file] = canvas.toDataURL("image/png");
  }
  all[name] = { name, manifest, images };
  localStorage.setItem(KEY, JSON.stringify(all));
}

export function deleteCharacter(name) {
  const all = readAll();
  delete all[name];
  localStorage.setItem(KEY, JSON.stringify(all));
}

async function toCanvas(dataURL) {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataURL; });
  const c = document.createElement("canvas");
  c.width = img.width; c.height = img.height;
  c.getContext("2d").drawImage(img, 0, 0);
  return c;
}

/** Load a stored character into runtime form (canvases keyed by sprite file name). */
export async function loadCharacter(name) {
  const rec = readAll()[name];
  if (!rec) throw new Error(`character not found: ${name}`);
  const canvases = {};
  for (const [file, url] of Object.entries(rec.images)) canvases[file] = await toCanvas(url);
  return { name, manifest: rec.manifest, canvases };
}
