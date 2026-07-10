# Sprites

These sprite assets are used by the Phase 5 MediaPipe fallback (`CLAUDE.md` §6),
which is now **ACTIVE**. The primary pipeline is FasterLivePortrait (neural),
which does not use sprites; the fallback composites these overlays instead.

## Pig set — `assets/sprites/pig/`

The shipped character is the pig (`manifest.json` name `돼지`). All sprites are
**512×512 RGBA, full-canvas overlays aligned to `base.png`** — each PNG occupies
the full 512×512 frame with transparent pixels everywhere except the feature it
draws, so features are composited by alpha-blending in place without any
per-sprite offset.

Composite (bottom → top):

```text
base.png                     # body + head + background (opaque)
  + eye_L_<open|closed>.png   # left eye state
  + eye_R_<open|closed>.png   # right eye state
  + mouth_<state>.png         # one mouth viseme
```

Files:

```text
base.png                      # base layer (character body/background)
eye_L_open.png  eye_L_closed.png
eye_R_open.png  eye_R_closed.png
mouth_closed.png              # neutral / lips-together
mouth_A.png mouth_E.png mouth_I.png mouth_O.png mouth_U.png
mouth_M.png                   # bilabial (M/B/P) viseme, extra
preview.png  preview_blink.png  # reference composites (not runtime layers)
manifest.json                 # name, size, mouthCenter, jawDrop, style hints
```

`manifest.json` reports `pupilRange: 0` and `browRange: 0` — this character has
no pupil-shift or eyebrow artwork.

## Missing-sprite report (pig set vs. `CLAUDE.md` §6 expected list)

Expected names in the spec differ from the shipped pig set. Per policy, missing
artwork is **reported, never auto-generated** — the fallback maps names and must
degrade gracefully where art is absent.

| Spec-expected      | Pig set          | Status                              |
| ------------------ | ---------------- | ----------------------------------- |
| `eye_left_open`    | `eye_L_open`     | present, **name differs**           |
| `eye_left_closed`  | `eye_L_closed`   | present, **name differs**           |
| `eye_right_open`   | `eye_R_open`     | present, **name differs**           |
| `eye_right_closed` | `eye_R_closed`   | present, **name differs**           |
| `eye_left_half`    | —                | **MISSING** (no half/mid states)    |
| `eye_right_half`   | —                | **MISSING** (no half/mid states)    |
| `mouth_neutral`    | `mouth_closed`   | present, **name differs**           |
| `mouth_A`          | `mouth_A`        | present, exact                      |
| `mouth_E`          | `mouth_E`        | present, exact                      |
| `mouth_I`          | `mouth_I`        | present, exact                      |
| `mouth_O`          | `mouth_O`        | present, exact                      |
| `mouth_U`          | `mouth_U`        | present, exact                      |

Additional gaps and extras:

- **No half-blink states.** Eyes are binary open/closed only; the fallback
  cannot render a distinct half-open eye for this character.
- **No brow sprites** (and none expected in §6's list). Brow blendshapes have no
  target artwork here (`browRange: 0`).
- **Extra:** `mouth_M` (bilabial viseme) beyond the spec's `A/E/I/O/U` set.
- **Extra:** `base.png`, `preview.png`, `preview_blink.png` — base layer and
  reference previews, not part of the spec's per-feature list.

## Policy

If any sprite is missing, the fallback must **report it** by name. Missing
sprites are **never** auto-generated — the user supplies the artwork.
