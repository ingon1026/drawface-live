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


def _border_median(img: Image.Image, box: tuple[int, int, int, int], ring: int = 4) -> tuple[int, int, int]:
    x0, y0, x1, y1 = box
    px = img.load()
    samples = []
    for x in range(max(0, x0 - ring), min(img.width, x1 + ring)):
        for y in list(range(max(0, y0 - ring), y0)) + list(range(y1, min(img.height, y1 + ring))):
            samples.append(px[x, y])
    for y in range(max(0, y0), min(img.height, y1)):
        for x in list(range(max(0, x0 - ring), x0)) + list(range(x1, min(img.width, x1 + ring))):
            samples.append(px[x, y])
    return tuple(int(statistics.median(c[i] for c in samples)) for i in range(3))


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


def build_character(canvas_img: Image.Image, out_dir: Path, name: str,
                    eyes: dict[str, tuple[int, int]], eye_half: int,
                    mouth_box: tuple[int, int, int, int]) -> Path:
    """All coordinates are 512-canvas pixels. eyes: {'L': (cx, cy), 'R': ...} (snapped to ink)."""
    eyes = {side: snap_to_ink(canvas_img, cx, cy, eye_half) for side, (cx, cy) in eyes.items()}
    base = canvas_img.copy()
    out_dir.mkdir(parents=True, exist_ok=True)
    d = ImageDraw.Draw(base)

    for side, (cx, cy) in eyes.items():
        box = (cx - eye_half, cy - eye_half, cx + eye_half, cy + eye_half)
        open_sprite = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
        open_sprite.paste(base.crop(box).convert("RGBA"), box[:2])
        open_sprite.save(out_dir / f"eye_{side}_open.png")

        closed = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
        ImageDraw.Draw(closed).arc((cx - eye_half, cy - eye_half * 0.6, cx + eye_half, cy + eye_half),
                                   20, 160, fill=_ink_color(base, box), width=4)
        closed.save(out_dir / f"eye_{side}_closed.png")
        d.rectangle(box, fill=_border_median(base, box))

    line = _ink_color(base, mouth_box)
    d.rectangle(mouth_box, fill=_border_median(base, mouth_box))
    base.convert("RGBA").save(out_dir / "base.png")

    mcx, mcy = (mouth_box[0] + mouth_box[2]) // 2, (mouth_box[1] + mouth_box[3]) // 2
    half_w = max(12, (mouth_box[2] - mouth_box[0]) // 2)
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
    subprocess.run([sys.executable, script, str(char_dir), "--auto-mouths", str(char_dir)],
                   check=True, cwd=ROOT, env=env)
    subprocess.run([sys.executable, script, str(char_dir)], check=True, cwd=ROOT, env=env)


class ClickUI:
    def __init__(self, root: tk.Tk, canvas_img: Image.Image, out_dir: Path, name: str) -> None:
        self.root = root
        self.img = canvas_img
        self.out_dir = out_dir
        self.name = name
        self.points: list[tuple[int, int]] = []
        root.title(f"온보딩 — {name}")

        self.canvas = tk.Canvas(root, width=CANVAS, height=CANVAS)
        self.canvas.pack()
        self._photo = ImageTk.PhotoImage(canvas_img)
        self.canvas.create_image(0, 0, anchor="nw", image=self._photo)
        self.canvas.bind("<Button-1>", self.on_click)

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
        self.canvas.delete("mark")
        self.gen_btn.config(state="disabled")
        self.status.set(f"클릭 ①/{len(CLICK_STEPS)}: {CLICK_STEPS[0]}")

    def on_click(self, e: tk.Event) -> None:
        if len(self.points) >= len(CLICK_STEPS):
            return
        self.points.append((e.x, e.y))
        self.canvas.create_oval(e.x - 3, e.y - 3, e.x + 3, e.y + 3,
                                outline="#e33", width=2, tags="mark")
        if len(self.points) == len(CLICK_STEPS):
            x0, y0 = self.points[2]
            x1, y1 = self.points[3]
            self.canvas.create_rectangle(x0, y0, x1, y1, outline="#e33", tags="mark")
            self.gen_btn.config(state="normal")
            self.status.set("좌표 완료 — [생성]을 누르세요")
        else:
            n = len(self.points)
            self.status.set(f"클릭 {'①②③④'[n]}/{len(CLICK_STEPS)}: {CLICK_STEPS[n]}")

    def generate(self) -> None:
        (lx, ly), (rx, ry), (mx0, my0), (mx1, my1) = self.points
        mouth = (min(mx0, mx1), min(my0, my1), max(mx0, mx1), max(my0, my1))
        self.status.set("생성 중…")
        self.root.update()
        build_character(self.img, self.out_dir, self.name,
                        {"L": (lx, ly), "R": (rx, ry)}, self.eye_half.get(), mouth)
        derive_all(self.out_dir)
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
