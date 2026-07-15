"""New-character onboarding: 4 clicks on a drawing -> ready-to-run sprite folder.

    python -m app.onboard <image> <name>                    # Tk click UI
    python -m app.onboard <image> <name> --eyes Lx,Ly,Rx,Ry --mouth x0,y0,x1,y1  # headless

Click order: left-eye center -> right-eye center -> mouth top-left -> mouth
bottom-right. The tool fits the drawing onto a 512 canvas, cuts open-eye
patches, draws closed-eye strokes, inpaints eye/mouth regions into base.png,
writes a proceduralMouth manifest, then runs scripts/derive_sprites.py so the
character is immediately usable in app.main / app.ui.

Core generation logic adapted from the user's own ~/face/character_builder.py.
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import tkinter as tk
from pathlib import Path

from PIL import Image, ImageDraw, ImageTk

ROOT = Path(__file__).resolve().parents[1]
CANVAS = 512
DEFAULT_STYLE = {"line": "#2b2b2b", "fill": "#8a3535", "tongue": "#d97b7b",
                 "teeth": "#ffffff", "width": 26}
CLICK_STEPS = ("왼눈 중심", "오른눈 중심", "입 좌상단", "입 우하단")


def fit_512(src: Image.Image) -> Image.Image:
    """Fit onto a 512 canvas padded with the drawing's border color."""
    edge = [src.getpixel((x, y)) for x in range(src.width) for y in (0, 1, src.height - 2, src.height - 1)] \
         + [src.getpixel((x, y)) for y in range(src.height) for x in (0, 1, src.width - 2, src.width - 1)]
    bg = tuple(int(statistics.median(c[i] for c in edge)) for i in range(3))
    s = min(CANVAS / src.width, CANVAS / src.height)
    w, h = int(src.width * s), int(src.height * s)
    canvas = Image.new("RGB", (CANVAS, CANVAS), bg)
    canvas.paste(src.resize((w, h), Image.LANCZOS), ((CANVAS - w) // 2, (CANVAS - h) // 2))
    return canvas


def inpaint_region(img: Image.Image, box: tuple[int, int, int, int], ring: int = 6) -> None:
    """Erase an eye/mouth box in-place with the surrounding skin tone.

    Fills EXACTLY the box (the open-eye sprite covers this same box, so neutral
    stays pixel-perfect — a feather that bled outside the box would show around
    the sprites). Colour = mean of the *non-ink* pixels in the surrounding ring,
    so nearby hair/outline is not averaged in (the old median went grey next to
    dark features and read as a stuck-on patch).
    """
    import numpy as np

    a = np.asarray(img.convert("RGB"), np.float32)
    x0, y0, x1, y1 = (int(v) for v in box)
    around = a[max(0, y0 - ring):y1 + ring, max(0, x0 - ring):x1 + ring].reshape(-1, 3)
    light = around[around.sum(1) > 300]                  # drop ink/hair pixels
    # median, not mean: robust to the few feature-edge pixels (e.g. lip red) that
    # survive the ink cut and would otherwise tint the fill into a faint patch
    skin = np.median(light if len(light) else around, axis=0)
    a[y0:y1, x0:x1] = skin
    img.paste(Image.fromarray(a.clip(0, 255).astype(np.uint8)))


def _ink_color(img: Image.Image, box: tuple[int, int, int, int]) -> str:
    """Median color of dark (ink) pixels inside box; falls back to near-black."""
    crop = img.crop(box)
    dark = [p for p in crop.getdata() if sum(p[:3]) < 300]
    if not dark:
        return "#1a1a1a"
    r, g, b = (int(statistics.median(c[i] for c in dark)) for i in range(3))
    return f"#{r:02x}{g:02x}{b:02x}"


def snap_to_ink(img: Image.Image, cx: int, cy: int, r: int) -> tuple[int, int]:
    """Snap a rough click to the centroid of dark (ink) pixels within ±r."""
    box = (max(0, cx - r), max(0, cy - r), min(img.width, cx + r), min(img.height, cy + r))
    crop = img.crop(box)
    pts = [(x, y) for y in range(crop.height) for x in range(crop.width)
           if sum(crop.getpixel((x, y))[:3]) < 300]
    if not pts:
        return cx, cy
    mx = sum(p[0] for p in pts) // len(pts)
    my = sum(p[1] for p in pts) // len(pts)
    return box[0] + mx, box[1] + my


def expand_box_to_ink(img: Image.Image, box: tuple[int, int, int, int],
                      pad: int = 4, cap_scale: float = 2.5, max_iter: int = 8) -> tuple[int, int, int, int]:
    """Grow a mouth box until it covers the whole drawn mouth (deep open mouths
    otherwise get erased partially and the leftover reads as a second mouth).
    Growth is capped so ink touching the face outline can't swallow the face."""
    import numpy as np

    a = np.asarray(img.convert("RGB"), dtype=np.int32).sum(axis=2)
    x0, y0, x1, y1 = (int(v) for v in box)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    max_w, max_h = max(24, (x1 - x0) * cap_scale), max(24, (y1 - y0) * cap_scale)
    bx0, by0 = int(cx - max_w / 2), int(cy - max_h / 2)
    bx1, by1 = int(cx + max_w / 2), int(cy + max_h / 2)

    for _ in range(max_iter):
        sy, ey = max(0, max(by0, y0 - pad)), min(a.shape[0], min(by1, y1 + pad) + 1)
        sx, ex = max(0, max(bx0, x0 - pad)), min(a.shape[1], min(bx1, x1 + pad) + 1)
        ys, xs = np.where(a[sy:ey, sx:ex] < 300)
        if not len(ys):
            break
        grown = (min(sx + xs.min(), x0), min(sy + ys.min(), y0),
                 max(sx + xs.max(), x1), max(sy + ys.max(), y1))
        if grown == (x0, y0, x1, y1):
            break
        x0, y0, x1, y1 = grown
    return x0 - 2, y0 - 2, x1 + 2, y1 + 2


def build_character(canvas_img: Image.Image, out_dir: Path, name: str,
                    eyes: dict[str, tuple[int, int]], eye_half: int,
                    mouth_box: tuple[int, int, int, int], *, expand_mouth: bool = True) -> Path:
    """Build a character from 512-canvas coordinates.

    Eye clicks are snapped to nearby ink. Headless callers keep the historic
    mouth auto-expansion; the interactive UI passes ``expand_mouth=False`` so
    its resizable red box is the exact region that gets used.
    """
    eyes = {side: snap_to_ink(canvas_img, cx, cy, eye_half) for side, (cx, cy) in eyes.items()}
    if expand_mouth:
        mouth_box = expand_box_to_ink(canvas_img, mouth_box)
    base = canvas_img.copy()
    out_dir.mkdir(parents=True, exist_ok=True)

    for side, (cx, cy) in eyes.items():
        box = (cx - eye_half, cy - eye_half, cx + eye_half, cy + eye_half)
        open_sprite = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
        open_sprite.paste(base.crop(box).convert("RGBA"), box[:2])
        open_sprite.save(out_dir / f"eye_{side}_open.png")

        closed = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
        ImageDraw.Draw(closed).arc((cx - eye_half, cy - eye_half * 0.6, cx + eye_half, cy + eye_half),
                                   20, 160, fill=_ink_color(base, box), width=4)
        closed.save(out_dir / f"eye_{side}_closed.png")
        inpaint_region(base, box)

    line = _ink_color(base, mouth_box)
    inpaint_region(base, mouth_box)
    base.convert("RGBA").save(out_dir / "base.png")

    # expand_box_to_ink returns numpy ints; cast so json.dumps stays happy
    mcx, mcy = int((mouth_box[0] + mouth_box[2]) // 2), int((mouth_box[1] + mouth_box[3]) // 2)
    half_w = int(max(12, (mouth_box[2] - mouth_box[0]) // 2))
    manifest = {
        "name": name,
        "pupilRange": 0, "browRange": 0, "jawDrop": 6,
        "mouthCenter": [mcx, mcy],
        "proceduralMouth": True,
        "mouthStyle": {**DEFAULT_STYLE, "line": line, "width": half_w},
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    return out_dir


def derive_all(char_dir: Path) -> None:
    """Run derive_sprites on the new folder.

    Auto-mouths first: it synthesizes mouth_closed.png for proceduralMouth
    characters, which the smile derivation in the default mode depends on.
    """
    script = str(ROOT / "scripts" / "derive_sprites.py")
    env = {**os.environ, "PYTHONPATH": ""}
    for extra in (["--auto-mouths", str(char_dir)], []):
        subprocess.run([sys.executable, script, str(char_dir), *extra],
                       check=True, cwd=ROOT, env=env, capture_output=True, text=True)


class ClickUI:
    HANDLE_RADIUS = 7
    MIN_MOUTH_SIZE = 12

    def __init__(self, root: tk.Tk, canvas_img: Image.Image, out_dir: Path, name: str) -> None:
        self.root = root
        self.img = canvas_img
        self.out_dir = out_dir
        self.name = name
        self.points: list[tuple[int, int]] = []
        self.drag: tuple[str, int, int, tuple[int, int, int, int]] | None = None
        root.title(f"온보딩 — {name}")

        self.canvas = tk.Canvas(root, width=CANVAS, height=CANVAS)
        self.canvas.pack()
        self._photo = ImageTk.PhotoImage(canvas_img)
        self.canvas.create_image(0, 0, anchor="nw", image=self._photo)
        self.canvas.bind("<ButtonPress-1>", self.on_press)
        self.canvas.bind("<B1-Motion>", self.on_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_release)

        bar = tk.Frame(root)
        bar.pack(fill="x", padx=8, pady=6)
        tk.Label(bar, text="눈 반박스(px)").pack(side="left")
        self.eye_half = tk.IntVar(value=16)
        tk.Spinbox(bar, from_=6, to=64, textvariable=self.eye_half, width=4).pack(side="left", padx=4)
        tk.Button(bar, text="다시 클릭", command=self.reset).pack(side="left", padx=8)
        self.gen_btn = tk.Button(bar, text="생성", state="disabled", command=self.generate)
        self.gen_btn.pack(side="left")
        self.status = tk.StringVar()
        tk.Label(root, textvariable=self.status, fg="#444").pack(anchor="w", padx=8, pady=(0, 6))
        self.reset()

    def reset(self) -> None:
        self.points.clear()
        self.drag = None
        self.canvas.delete("mark")
        self.gen_btn.config(state="disabled")
        self.status.set(f"클릭 ①/{len(CLICK_STEPS)}: {CLICK_STEPS[0]}")

    def mouth_box(self) -> tuple[int, int, int, int]:
        """Return the two mouth clicks as a normalized rectangle."""
        (x0, y0), (x1, y1) = self.points[2:4]
        return min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)

    def set_mouth_box(self, box: tuple[int, int, int, int]) -> None:
        x0, y0, x1, y1 = box
        self.points[2] = (round(x0), round(y0))
        self.points[3] = (round(x1), round(y1))

    def redraw_marks(self) -> None:
        self.canvas.delete("mark")
        for x, y in self.points:
            self.canvas.create_oval(x - 3, y - 3, x + 3, y + 3,
                                    outline="#e33", width=2, tags="mark")
        if len(self.points) != len(CLICK_STEPS):
            return
        x0, y0, x1, y1 = self.mouth_box()
        self.canvas.create_rectangle(x0, y0, x1, y1, outline="#e33", width=2, tags="mark")
        for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
            self.canvas.create_rectangle(x - 4, y - 4, x + 4, y + 4,
                                         fill="white", outline="#e33", width=2, tags="mark")

    def hit_mouth_box(self, x: int, y: int) -> str | None:
        """Return a resize handle or 'move' for the current mouth rectangle."""
        if len(self.points) != len(CLICK_STEPS):
            return None
        x0, y0, x1, y1 = self.mouth_box()
        for handle, cx, cy in (("nw", x0, y0), ("ne", x1, y0),
                               ("se", x1, y1), ("sw", x0, y1)):
            if abs(x - cx) <= self.HANDLE_RADIUS and abs(y - cy) <= self.HANDLE_RADIUS:
                return handle
        return "move" if x0 <= x <= x1 and y0 <= y <= y1 else None

    def on_press(self, e: tk.Event) -> None:
        if len(self.points) >= len(CLICK_STEPS):
            handle = self.hit_mouth_box(e.x, e.y)
            if handle:
                self.drag = (handle, e.x, e.y, self.mouth_box())
            return
        self.points.append((e.x, e.y))
        if len(self.points) == len(CLICK_STEPS):
            self.gen_btn.config(state="normal")
            self.status.set("좌표 완료 — 모서리 드래그로 크기 조절, 박스 안을 드래그해 이동 후 [생성]")
        else:
            n = len(self.points)
            self.status.set(f"클릭 {'①②③④'[n]}/{len(CLICK_STEPS)}: {CLICK_STEPS[n]}")
        self.redraw_marks()

    def on_drag(self, e: tk.Event) -> None:
        if not self.drag:
            return
        handle, start_x, start_y, original = self.drag
        left, top, right, bottom = original
        if handle == "move":
            width, height = right - left, bottom - top
            left = max(0, min(CANVAS - width, left + e.x - start_x))
            top = max(0, min(CANVAS - height, top + e.y - start_y))
            right, bottom = left + width, top + height
        elif handle == "nw":
            left = max(0, min(right - self.MIN_MOUTH_SIZE, e.x))
            top = max(0, min(bottom - self.MIN_MOUTH_SIZE, e.y))
        elif handle == "ne":
            right = min(CANVAS, max(left + self.MIN_MOUTH_SIZE, e.x))
            top = max(0, min(bottom - self.MIN_MOUTH_SIZE, e.y))
        elif handle == "se":
            right = min(CANVAS, max(left + self.MIN_MOUTH_SIZE, e.x))
            bottom = min(CANVAS, max(top + self.MIN_MOUTH_SIZE, e.y))
        elif handle == "sw":
            left = max(0, min(right - self.MIN_MOUTH_SIZE, e.x))
            bottom = min(CANVAS, max(top + self.MIN_MOUTH_SIZE, e.y))
        self.set_mouth_box((left, top, right, bottom))
        self.redraw_marks()

    def on_release(self, _e: tk.Event) -> None:
        if self.drag:
            self.drag = None
            self.status.set("입 영역을 조정했습니다 — [생성]을 누르세요")

    def generate(self) -> None:
        (lx, ly), (rx, ry), (mx0, my0), (mx1, my1) = self.points
        mouth = (min(mx0, mx1), min(my0, my1), max(mx0, mx1), max(my0, my1))
        self.status.set("생성 중…")
        self.root.update()
        try:
            build_character(self.img, self.out_dir, self.name,
                            {"L": (lx, ly), "R": (rx, ry)}, self.eye_half.get(), mouth,
                            expand_mouth=False)
            derive_all(self.out_dir)
        except subprocess.CalledProcessError as err:
            tail = (err.stderr or "").strip().splitlines()[-1:] or [f"exit {err.returncode}"]
            self.status.set(f"생성 실패 (파생 단계): {tail[0]}")
            return
        except Exception as err:  # surface instead of a console-only traceback
            self.status.set(f"생성 실패: {err}")
            return
        self.status.set(f"완료 — {self.out_dir.relative_to(ROOT)} 생성됨. 컨트롤 패널에서 선택하세요.")
        self.gen_btn.config(state="disabled")


def main() -> int:
    ap = argparse.ArgumentParser(description="drawing -> character folder onboarding")
    ap.add_argument("image", help="source drawing (photo/scan)")
    ap.add_argument("name", help="character name -> assets/sprites/<name>/")
    ap.add_argument("--eyes", help="headless: Lx,Ly,Rx,Ry (512-canvas px)")
    ap.add_argument("--mouth", help="headless: x0,y0,x1,y1 (512-canvas px)")
    ap.add_argument("--eye-size", type=int, default=16, help="eye half-box in canvas px")
    args = ap.parse_args()

    out_dir = ROOT / "assets" / "sprites" / args.name
    if (out_dir / "base.png").exists():
        ap.error(f"{out_dir} already exists — pick another name or remove it first")
    canvas_img = fit_512(Image.open(args.image).convert("RGB"))

    if args.eyes and args.mouth:
        lx, ly, rx, ry = map(int, args.eyes.split(","))
        mouth = tuple(map(int, args.mouth.split(",")))
        build_character(canvas_img, out_dir, args.name,
                        {"L": (lx, ly), "R": (rx, ry)}, args.eye_size, mouth)
        derive_all(out_dir)
        print(f"done: {out_dir}")
        return 0

    root = tk.Tk()
    ClickUI(root, canvas_img, out_dir, args.name)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
