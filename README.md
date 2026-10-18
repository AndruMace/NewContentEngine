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

In the Playground, **Export for upload** renders exactly what you're previewing through the same
pipeline as the CLI and opens its upload page under **Batches & Review**. While it renders,
Claude writes the title, description, hashtags, captions, cover text and a pinned comment for
YouTube Shorts, TikTok, Instagram Reels and X (add optional notes for Claude first). Each field
has a copy button, can be edited in place (with an emoji picker), and each platform can be
regenerated on its own. The video is tracked in the day's Manual batch as approved, so you can
paste post links and it counts in analytics. The equivalent CLI command is shown underneath.

## Daily workflow: batches and review

1. *(Optional, once)* `cp .env.example .env` and add your `ANTHROPIC_API_KEY`. Claude then
   plans each video's parameters and writes the hook, CTA, title and captions per platform.
   Without a key, batches still work using template copy.
2. `npm run dev`, then open **Batches & Review**. Choose how many posts you want and how many
   candidates per post (default 3 × 3 = 9), length range, templates, themes, and optional
   notes for today, then click **Start batch**. A 9-video batch takes roughly 6–8 minutes;
   the Mac is kept awake while it runs, and you get a notification when it's done.
3. Review the ranked candidates: **Approve / Reject**, **Re-roll** (different run of the same
   idea, new copy, or a new concept), or edit the copy (changing the on-screen hook/CTA
   re-renders that video).
4. **Export for upload** writes `data/exports/<date>/<slug>/` (video, cover, `youtube.txt`,
   `tiktok.txt`, `instagram.txt`, `x.txt`, `bundle.zip`) and opens the same upload page, with
   every platform's text ready to copy.
5. After posting, paste the post URLs into the upload page or the card (used by analytics).

From the terminal: `npm run batch` (uses the running server if there is one, so the UI sees
it), with flags like `--posts 2 --factor 2 --templates ring-escape,marble-race --min 20 --max 35`.
`npm run batch -- --dry` runs an offline smoke test with a mock planner (server must be stopped).

Batches, renders, reviews and exports live in `data/sqlite.db`. A batch interrupted by a
restart resumes automatically. **Clean up** in the Review sidebar deletes old renders that
aren't approved or exported.

## Templates

| Template | Family | What happens |
|---|---|---|
| `ring-escape` | bounce | Ball escapes rotating rings with gaps; rings shatter; melody note per bounce |
| `grow-until-full` | bounce | Ball grows on every bounce until it fills the circle; paint trail |
| `marble-race` | race | Elimination (or finish-line) marble race on a procedural course; flags or colours |
| `ball-battle` | race | Weapon balls (sword, daggers, hammer, bow) in a shrinking arena; FFA, teams, giant or bracket |
| `polyrhythm` | kinetic | Arcs, pendulum wave, polygons, string art, piano keys or 3D pendulums; 5 speed patterns; loops perfectly, all re-sync at the end |
| `sorting-race` | kinetic | 2-4 sorting algorithms race on the same data with pitch-mapped tones |
| `sand-pour` | particles | Falling-sand layers into a jar, heart, hourglass or Galton board (bell curve) |
| `territory-war` | race | 2-4 teams (colours or country flags) flip tiles with bouncing balls; live share bar; biggest territory wins |
| `snake-ai` | kinetic | AI snake tries to fill the whole board; ends full or trapped a few cells short |
| `shell-escape` | bounce | 3D: ball bounces inside nested spinning glass polyhedra; each shell shatters when it finds the window |
| `gravity-funnel` | race | 3D: marbles (colours or flags) spiral down a coin-funnel; last one still spinning wins |
| `colliding-blocks` | bounce | Blocks 1 kg vs 100ⁿ kg: the collision counts spell the digits of π (3, 31, 314…), with a velocity-circle diagram |
| `pathfinding-race` | kinetic | BFS, DFS, Dijkstra, A*, Greedy… race through the same maze/field; badges show who found the shortest route |
| `fourier-drawing` | kinetic | Spinning circles draw a mystery country, US state, dinosaur, animal or mythical creature, 1 → 200 circles, then the reveal |
| `spin-battle` | race | 3D: two battle tops (Attack, Defense, Stamina, Balance) clash in a bowl stadium after a 3-2-1 launch; spin finish or over finish (pocket / over the wall); single duel, first-to-N points match, or 3-4 top free-for-all |
| `bounce-keys` | kinetic | Guess the song: a ball bounces note to note down blocks, a keyboard or 3D towers, exactly on the beat; title revealed at the end |
| `rps-battle` | race | Rock-paper-scissors (or fire/water/leaf, or three flags) swarms convert whoever they beat; live share bar; one side takes everyone, or the biggest wins at the buzzer |
| `trick-shot` | bounce | 3D: a glass cabinet of tilted boards, rods, pegs, bumpers and spinners with a cup on the floor; bounce until it drops in, an AI cannon closing in shot by shot, or a first-to-N-cups race; slow-motion replay from beside the cup |
| `marble-machine` | kinetic | Guess the song, 3D Rube Goldberg: a peg drum sends marbles through a helix, seesaws, a loop-and-jump and zigzag rails onto vibraphone bars on the beat; a paddle wheel and bucket elevator bring them back; the last one sets off dominoes that ring the reveal bell |

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
apps/server         Local API: batch runner, seed-search worker pool, persistent render queue
                    (one reused Chrome), review/export actions, SQLite (node:sqlite), SSE
packages/engine     Runner (fixed-step loop), PRNG, Template interface, themes, overlays, bloom
packages/physics    Collision helpers, circle-body World, deterministic math
packages/templates  One folder per template (schema, sim, render, audio mapping, drama score)
packages/audio      Public-domain melody library, Web Audio synth, offline renderer, WAV writer
packages/render     Headless Chrome harness (WebCodecs → MP4), FFmpeg mastering, QC, CLI
packages/planner    Arm selection (Thompson sampling), Claude concepts + captions, fallback copy
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
