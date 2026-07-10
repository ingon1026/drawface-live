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

- **Half-blink states** (`eye_*_half`) and **smile** (`mouth_smile`) are now
  **derived mechanically** from the existing artwork by `scripts/derive_sprites.py`
  (vertical squash of the open eye / corner-lift of the closed mouth).
  `scripts/setup.sh` runs this automatically; no new artwork is drawn.
- **No brow sprites** (and none expected in §6's list). Brow blendshapes have no
  target artwork here (`browRange: 0`).
- **Extra:** `mouth_M` (bilabial viseme) beyond the spec's `A/E/I/O/U` set.
- **Extra:** `base.png`, `preview.png`, `preview_blink.png` — base layer and
  reference previews, not part of the spec's per-feature list.

## Adding a NEW character (auto viseme path)

A new character needs only **4 hand-made inputs** in `assets/sprites/<name>/`:
`base.png` (512×512), `eye_L_open/closed.png`, `eye_R_open/closed.png`,
`mouth_closed.png`, plus a `manifest.json` with `mouthStyle` colors.
Then derive everything else:

```bash
PYTHONPATH= .venv/bin/python scripts/derive_sprites.py assets/sprites/<name>                     # half-eye + smile
PYTHONPATH= .venv/bin/python scripts/derive_sprites.py assets/sprites/<name> --auto-mouths assets/sprites/<name>  # A/E/I/O/U
```

The auto visemes reuse the character's own closed-mouth stroke as lips (ink
color/thickness sampled from it) and fill the interior with `mouthStyle` colors.
If `mouth_closed.png` is absent AND the manifest declares `proceduralMouth: true`
(e.g. the stick character), a closed-mouth stroke is first synthesized from
`mouthCenter`/`mouthStyle` — that is the manifest's own definition of the mouth,
not invented artwork.
Hand-made viseme art (e.g. the pig's GPT-assisted set) always takes priority —
`--auto-mouths` refuses to overwrite an existing set without `--force`.

## Policy

If any required sprite is missing, the fallback must **report it** by name.
Missing artwork is **never invented** — derivations above are geometric
transforms of the user's own drawing, and the user can always override them
with hand-made files of the same name.
