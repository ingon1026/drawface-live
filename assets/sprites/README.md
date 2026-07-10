# Sprites

These sprite assets are used **only** by the Phase 5 MediaPipe fallback
(`CLAUDE.md` §6), which is **not implemented yet**. The primary pipeline is
FasterLivePortrait (neural), which does not use sprites.

## Expected files

```text
eye_left_open.png
eye_left_half.png
eye_left_closed.png
eye_right_open.png
eye_right_half.png
eye_right_closed.png
mouth_neutral.png
mouth_A.png
mouth_E.png
mouth_I.png
mouth_O.png
mouth_U.png
```

## Policy

If any sprite is missing, the fallback must **report it** by name. Missing
sprites are **never** auto-generated — the user supplies the artwork.
