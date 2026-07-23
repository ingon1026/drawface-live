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
    // source.png 는 fitTo 가 불투명 배경으로 채운 hi-res warp 텍스처(알파 없음, 최대 1024px)라
    // PNG 로 저장하면 수 MB → localStorage quota 초과로 저장이 통째로 실패한다. 알파가 없으니
    // JPEG 로 압축(해상도는 유지). 알파가 필요한 나머지 스프라이트만 PNG.
    images[file] = file === "source.png"
      ? canvas.toDataURL("image/jpeg", 0.85)
      : canvas.toDataURL("image/png");
  }
  all[name] = { name, manifest, images };
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch (e) {
    if (e.name === "QuotaExceededError")
      throw new Error("브라우저 저장 공간이 가득 찼어요. 기존 캐릭터를 삭제하고 다시 시도하세요.");
    throw e;
  }
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
