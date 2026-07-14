"""DrawFace Live — Phase 4 control panel (tkinter, stdlib only).

Thin launcher over `python -m app.main`: the pipeline stays a single source of
truth; the panel starts/stops it as a subprocess and surfaces its errors.
Video keys still work in the render window: q quit · c recalibrate · m mirror.

Run: PYTHONPATH= .venv/bin/python -m app.ui
"""
from __future__ import annotations

import collections
import os
import subprocess
import sys
import threading
import time
import tkinter as tk
from pathlib import Path
from tkinter import ttk

ROOT = Path(__file__).resolve().parents[1]


def scan_characters() -> list[str]:
    base = ROOT / "assets" / "sprites"
    return sorted(str(d.relative_to(ROOT)) for d in base.iterdir()
                  if (d / "base.png").exists()) if base.is_dir() else []


def scan_cameras() -> list[str]:
    cams = []
    for dev in sorted(Path("/dev").glob("video*"), key=lambda p: int(p.name[5:])):
        name_file = Path("/sys/class/video4linux") / dev.name / "name"
        name = name_file.read_text().strip() if name_file.exists() else "?"
        cams.append(f"{dev.name[5:]} — {name}")
    return cams


class Panel:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.proc: subprocess.Popen | None = None
        root.title("DrawFace Live")
        root.resizable(False, False)
        frm = ttk.Frame(root, padding=12)
        frm.grid(sticky="nsew")

        chars, cams = scan_characters(), scan_cameras()
        self.character = tk.StringVar(value=chars[0] if chars else "")
        self.camera = tk.StringVar(value=next((c for c in cams if c.startswith("4 ")), cams[0] if cams else ""))
        self.mirror = tk.BooleanVar(value=True)
        self.preview = tk.BooleanVar(value=True)
        self.overlay = tk.BooleanVar(value=True)

        ttk.Label(frm, text="캐릭터").grid(row=0, column=0, sticky="w")
        ttk.Combobox(frm, textvariable=self.character, values=chars, state="readonly", width=32)\
            .grid(row=0, column=1, pady=2)
        ttk.Label(frm, text="카메라").grid(row=1, column=0, sticky="w")
        ttk.Combobox(frm, textvariable=self.camera, values=cams, state="readonly", width=32)\
            .grid(row=1, column=1, pady=2)

        opts = ttk.Frame(frm)
        opts.grid(row=2, column=0, columnspan=2, sticky="w", pady=4)
        ttk.Checkbutton(opts, text="미러 컨트롤", variable=self.mirror).pack(side="left")
        ttk.Checkbutton(opts, text="웹캠 프리뷰", variable=self.preview).pack(side="left", padx=8)
        ttk.Checkbutton(opts, text="추적 시각화", variable=self.overlay).pack(side="left")

        self.btn = ttk.Button(frm, text="시작", command=self.toggle)
        self.btn.grid(row=3, column=0, columnspan=2, sticky="ew", pady=(8, 4))

        self.status = tk.StringVar(value="대기 중 — 백엔드: sprite/mediapipe")
        ttk.Label(frm, textvariable=self.status, wraplength=340, foreground="#444")\
            .grid(row=4, column=0, columnspan=2, sticky="w")
        ttk.Label(frm, text="영상 창 키: q 종료 · c 재캘리브레이션 · m 미러 전환",
                  foreground="#888").grid(row=5, column=0, columnspan=2, sticky="w", pady=(4, 0))

        root.protocol("WM_DELETE_WINDOW", self.close)
        self.poll()

    def toggle(self) -> None:
        self.stop() if self.proc else self.start()

    def start(self) -> None:
        if not self.character.get() or not self.camera.get():
            self.status.set("오류: 캐릭터 또는 카메라가 없음 — scripts/setup.sh 와 usbipd attach 확인")
            return
        cmd = [sys.executable, "-m", "app.main",
               "--character", self.character.get(),
               "--camera", self.camera.get().split(" ")[0],
               "--mirror", "on" if self.mirror.get() else "off"]
        if not self.preview.get():
            cmd.append("--no-preview")
        if not self.overlay.get():
            cmd.append("--no-debug-overlay")
        # PYTHONPATH= guards against unrelated site packages (e.g. a sourced ROS env)
        self.proc = subprocess.Popen(cmd, cwd=ROOT, env={**os.environ, "PYTHONPATH": ""},
                                     stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        self.started_at = time.monotonic()
        self.err_tail: collections.deque[str] = collections.deque(maxlen=4)
        # Drain stderr continuously — an unread PIPE fills up and blocks the child.
        threading.Thread(target=self._drain, args=(self.proc,), daemon=True).start()
        self.btn.config(text="정지")
        self.status.set("시작 중 — 추적 모델 로딩(수 초), 곧 영상 창이 뜹니다…")

    def _drain(self, proc: subprocess.Popen) -> None:
        with open(ROOT / "outputs" / "ui_child.log", "w", encoding="utf-8") as f:
            for line in proc.stderr:
                self.err_tail.append(line.strip())
                f.write(line)
                f.flush()

    def stop(self) -> None:
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.proc.kill()
            self.proc = None
        self.btn.config(text="시작")
        self.status.set("정지됨")

    def poll(self) -> None:
        """Surface unexpected exits (with the child's own error) and startup progress."""
        if self.proc:
            if self.proc.poll() is not None:
                code = self.proc.returncode
                err = [ln for ln in self.err_tail if ln]
                self.proc = None
                self.btn.config(text="시작")
                if code == 0:
                    self.status.set("종료됨 (영상 창에서 q)")
                else:
                    tail = " / ".join(err[-2:]) if err else f"exit code {code}"
                    self.status.set(f"오류로 종료: {tail}")
            elif time.monotonic() - self.started_at > 6:
                self.status.set("실행 중 — 영상 창이 안 보이면 작업표시줄/다른 창 뒤를 확인. FPS는 영상 창 좌상단")
        self.root.after(500, self.poll)

    def close(self) -> None:
        self.stop()
        self.root.destroy()


def main() -> int:
    root = tk.Tk()
    Panel(root)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
