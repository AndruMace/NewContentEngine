# Sim Studio

Generates satisfying physics-simulation videos (9:16, 1080×1920, 60 fps) for YouTube Shorts, TikTok and X.

Every video is fully defined by a **recipe**: `(template, params, theme, melody, seed, copy)`.
Simulations are deterministic (fixed timestep + seeded PRNG), so the live preview, the headless
seed search and the final render all produce the identical run, and audio is rendered offline from
the sim's event log for sample-accurate sync.

## Quick start

```bash
npm install
npm run dev          # Playground at http://localhost:5173 (+ render API on :5174)
npm test             # determinism, physics, sorting, melody and math tests
```

In the Playground, **Export MP4** renders exactly what you're previewing through the same
pipeline as the CLI, shows progress, and gives you Download / Cover / Show in Finder buttons.
The equivalent CLI command is shown underneath for reference.

## Templates

| Template | Family | What happens |
|---|---|---|
| `ring-escape` | bounce | Ball escapes rotating rings with gaps; rings shatter; melody note per bounce |
| `grow-until-full` | bounce | Ball grows on every bounce until it fills the circle; paint trail |
| `marble-race` | race | Elimination (or finish-line) marble race on a procedural course; flags or colours |
| `ball-battle` | race | Balls with spinning swords that grow on every hit; HP bars; last one standing |
| `polyrhythm` | kinetic | Arcs or pendulum wave; perfectly looping, all elements re-sync at the end |
| `sorting-race` | kinetic | 2-4 sorting algorithms race on the same data with pitch-mapped tones |
| `sand-pour` | particles | Falling-sand layers into a jar, heart, hourglass or Galton board (bell curve) |
| `liquid-mix` | particles | Two or three coloured liquids pour into a glass/bowl and blend |

Themes: Neon Dark, Pastel Minimal, Retro CRT, Monochrome Gold, Sunset, Deep Ocean.
Melodies: 15 public-domain tunes (Beethoven, Mozart, Grieg, Bach, Pachelbel, Joplin, traditional).

Render a video (needs Google Chrome and `ffmpeg` installed):

```bash
# Search 400 seeds for the most dramatic ~30s run, then render it
npm run render -- --template ring-escape --search 400 --target 30

# Choose theme / melody / params / copy
npm run render -- --template ring-escape --theme mono-gold --melody mountain-king \
  --params '{"ringCount":30,"gapPattern":"aligned"}' --hook "Can it escape 30 rings?" --search 400 --target 25

# Re-render an exact recipe (the Playground's "Copy render command" button produces this)
npm run render -- --recipe data/renders/<day>/<id>/recipe.json
```

Output goes to `data/renders/<date>/<id>/`:

| File | What |
|---|---|
| `final.mp4` | Upload-ready: H.264 High + AAC 320k, loudness-normalised to -14 LUFS |
| `cover.jpg` | Cover frame (hook visible, scene intact) |
| `contact.jpg` | 12-frame contact sheet for quick review |
| `recipe.json` | Exact recipe to reproduce the video |
| `events.json` | Sim + audio event log (used for QC and, later, retention analysis) |
| `result.json` | QC report, drama score, timings |

## Layout

```
apps/web            Playground: live preview with audio, param sliders, seed search, export
apps/server         Local API: render queue (one reused Chrome), progress via SSE, file serving
packages/engine     Runner (fixed-step loop), PRNG, Template interface, themes, overlays, bloom
packages/physics    Collision helpers, circle-body World, deterministic math
packages/templates  One folder per template (schema, sim, render, audio mapping, drama score)
packages/audio      Public-domain melody library, Web Audio synth, offline renderer, WAV writer
packages/render     Headless Chrome harness (WebCodecs → MP4), FFmpeg mastering, QC, CLI
```

## Adding a template

Implement `Template<P, S>` from `packages/engine/src/types.ts` and register it in
`packages/templates/src/index.ts`. Rules:

- `step()` must be deterministic: use `ctx.rng` for physics randomness, `ctx.fxRng` for
  visual-only randomness, never `Math.random()` or wall-clock time.
- Use `@sim/physics/math` (`sin`, `cos`, `atan2`, `exp`, `log`, `pow`, `hypot`) instead of
  `Math.*` for anything that feeds back into physics. Chrome and Node ship different libm
  implementations, and a 1-ulp difference changes the outcome of a chaotic sim. Every render
  re-runs the sim in Node and fails QC if the browser's event log differs.
- Skip visual-only work when `ctx.visual` is false (seed search runs thousands of sims).
- Emit events for everything audible; `audio()` maps them to notes/SFX.
- `score()` rates a finished run for drama (target-length fit, pacing, late climax); seed
  search picks the best-scoring seed.

The determinism tests in `packages/templates/src/determinism.test.ts` run against every
registered template automatically.

## Music

Only public-domain compositions, transcribed by hand in `packages/audio/src/melodies.ts`
(never copied from MIDI sites, whose arrangements can be copyrighted).

## Debug scripts

```bash
npx tsx scripts/survey.ts <template> <seeds> <targetS> '<params json>'   # duration + score spread
npx tsx scripts/compare-events.ts data/renders/<day>/<id>              # browser vs Node event log
npx tsx scripts/diff-events.ts data/renders/<day>/<id>                 # first divergent event
```
