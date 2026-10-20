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
| `marble-race-3d` | race | 3D, real rolling physics (Rapier): marbles race down a seeded tower (drops, hairpins, helixes, coin funnels, pegs, spinners); elimination rounds with gates, or first past the finish. Looks: classic wood and brass, futuristic, arctic ice (photoreal), or neon |
| `ball-battle` | race | Weapon balls (sword, daggers, hammer, bow) in a shrinking arena; FFA, teams, giant or bracket |
| `polyrhythm` | kinetic | Arcs, pendulum wave, polygons, string art, piano keys or 3D pendulums; 5 speed patterns; loops perfectly, all re-sync at the end |
| `sorting-race` | kinetic | 2-4 sorting algorithms race on the same data with pitch-mapped tones |
| `sand-pour` | particles | Falling-sand layers into a jar, heart, hourglass or Galton board (bell curve) |
| `territory-war` | race | 2-4 teams (colours or country flags) flip tiles with bouncing balls; live share bar; biggest territory wins |
| `snake-ai` | kinetic | AI snake tries to fill the whole board; ends full or trapped a few cells short |
| `shell-escape` | bounce | 3D, real rigid-body physics (Rapier): ball bounces inside nested spinning glass polyhedra; each shell shatters into shards that rattle round the next shell and can knock the ball |
| `gravity-funnel` | race | 3D: marbles (colours or flags) spiral down a coin-funnel; last one still spinning wins |
| `math-curiosities` | bounce | Surprising maths, one per video (`mode`): colliding blocks that count out π, Collatz hailstone numbers, times tables on a circle, the sunflower (golden) angle, the chaos game, the Monty Hall problem and the birthday paradox |
| `pathfinding-race` | kinetic | BFS, DFS, Dijkstra, A*, Greedy… race through the same maze/field; badges show who found the shortest route |
| `fourier-drawing` | kinetic | Spinning circles draw a mystery country, US state, dinosaur, animal or mythical creature, 1 → 200 circles, then the reveal |
| `spin-battle` | race | 3D: two battle tops (Attack, Defense, Stamina, Balance) clash in a bowl stadium after a 3-2-1 launch; spin finish or over finish (pocket / over the wall); single duel, first-to-N points match, or 3-4 top free-for-all |
| `bounce-keys` | kinetic | Guess the song: a ball bounces note to note down blocks, a keyboard or 3D towers, exactly on the beat; title revealed at the end |
| `rps-battle` | race | Rock-paper-scissors (or fire/water/leaf, or three flags) swarms convert whoever they beat; live share bar; one side takes everyone, or the biggest wins at the buzzer |
| `trick-shot` | bounce | 3D: a glass cabinet of tilted boards, rods, pegs, bumpers and spinners with a cup on the floor; bounce until it drops in, an AI cannon closing in shot by shot, or a first-to-N-cups race; slow-motion replay from beside the cup |
| `marble-machine` | kinetic | Guess the song, 3D Rube Goldberg: a peg drum sends marbles through a helix, seesaws, a loop-and-jump and zigzag rails onto vibraphone bars on the beat; a paddle wheel and bucket elevator bring them back; the last one sets off dominoes that ring the reveal bell |
| `rube-goldberg` | kinetic | 3D, real rigid-body physics (Rapier): a Rube Goldberg marble machine generated per seed and tested as it is built (funnels, ramps, spiral, vortex, dominoes, Newton's cradle, paddle wheel, catapult, xylophone steps, zigzag peg drop) ending on a brass bell; photoreal studio look (five backdrops) with foley and a marimba melody |
| `who-would-win` | race | 3D low-poly "who would win": real animals, mythical creatures and fighters (Bull, Horse, Unicorn, Stag, Deer, Donkey, Alpaca, Wolf, Husky, Fox, Swordsman, King, Brawler, Dragon, Giant Spider) battle in a colosseum. Duel: VS card with stat bars, HP bars, hit freezes, staggers and damage numbers, a knockout and its instant replay. Horde: how many of a small kind it takes to beat a big one, let in through the gates one after another. Animated CC0 models by Quaternius (built by `scripts/build-creatures.ts`); balance check: `npx tsx scripts/battle-matrix.ts` |

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

## Long-form ambient videos

Hours-long background videos (study, work, sleep): 1920×1080 at 30 fps, mastered quietly to
−21 LUFS. A long-form template renders a seamless **master loop** (20–60 min, default 30), which
is repeated to the final length without re-encoding. These templates are kept out of batches, the
planner and analytics entirely (long uploads on the channel are ignored by the YouTube sync).

| Template | What happens |
|---|---|
| `cabin-storm` | Inside a log cabin: a stone fireplace with a crackling fire between two big windows, a thunderstorm (or snow) outside with swaying pines, rain on the glass, and lightning that throws the window shapes across the floor. Settings: storm, lightning per hour, thunder volume, fire size, rain or snow, rain sound |
| `orbital-viewport` | Looking out of a spaceship's viewport at a large planet turning below (earthlike, ocean, desert, ice or a gas giant), clouds drifting and reshaping, an atmosphere glowing at the horizon, the occasional shooting star; optional rings and moons; cool, amber or red cabin lighting; the ship's room tone and hum with soft console blips |
| `night-train` | A sleeper compartment at night: walnut panelling, a table lamp under the window, pillows on the berth. The countryside slides past (hills with town lights, farms, tree lines), with stations it slows through, level crossings with their bells, bridges and tunnels; rain on the glass, snow streaming past, or a clear moonlit night. The track is a ring exactly one loop long, so the wheels' clickety-clack keeps its rhythm across the join. Settings: weather, intensity, speed, jointed or welded track, lights, crossings/bridges/tunnels per hour, horn, lamp |
| `deep-sea` | Deep Sea Submarine: the pilot's seat of a small submarine cruising forward through the ocean, a big acrylic dome in front, the console's green-lit dials, meters and sonar scope glowing in the dark. Twilight zone (lanternfish, comb jellies, squid, siphonophores, mantas, a blue shark, a whale far off, singing), abyss (anglerfish, gulper eels, vampire squid, glowing comb jellies and siphonophores, sparkles, lit by the headlights) or sunlit reef (reef fish shoals, sea turtles, rays, a reef shark, caustics over coral). A few jellyfish everywhere, swimming in pulses. Settings: depth, marine life, whales per hour, headlights, marine snow, sonar, creaks, cruising speed |

**In the app:** open the **Ambient** tab. Pick a scene, a seed and its settings, and watch the
16:9 preview with its sound; the scrub bar covers the whole master loop (it plays on from the top
at the end). Choose the loop length (20–60 min) and the final length (1–12 h), add optional notes
for Claude, and press **Render**. Renders queue behind any Shorts in the render queue and keep the
Mac awake while they run (`caffeinate`). Each one shows its stage, progress and time left.
**Cancel** stops after the current 5-minute segment, and **Retry** resumes from there; a server
restart resumes on its own. While it renders, Claude writes the YouTube title, description, tags
and thumbnail text (plain copy without an API key). Each field can be copied, edited, or rewritten
with new notes. When it's done the card has the video, its thumbnail, the QC result and size, and
**Show in Finder**. Uploading is manual for now (YouTube only); the YouTube sync ignores these
videos. They also appear under **All renders** with a *Long-form* label.

```bash
npm run render -- --template cabin-storm --loop 30m --length 3h
npm run render -- --template cabin-storm --loop 60s --length 3m --test    # quick test loop
```

The loop renders in 5-minute segments (video streamed to disk as it encodes, audio crossfaded
where segments join), so memory stays flat and a render interrupted part-way resumes when run
again with the same `--recipe` and `--out`. Output: `final.mp4`, `thumbnail.jpg` (1280×720),
`contact.jpg`, plus `loop.mp4` and `loop.flac` (the master loop). QC checks the loop join (picture
and sound), loudness, flashes per second (at most 3) and long black or frozen stretches.

Trying out new long-form visuals: set `SIM_RENDER_SOFTWARE=1` to render on the CPU (SwiftShader)
instead of the GPU. It is far slower, but nothing a page does can reach the GPU driver: a canvas
`filter` (blur) applied to thousands of shapes once hung the GPU and crashed the Mac. Use stills
(`--still 12,40`) to look at frames quickly.

Rules for long-form templates (on top of the ones below): every frame must depend only on `t`
(a segment can start anywhere), and everything must repeat exactly over the loop. Run noise on a
circle in time, give anything periodic a whole number of cycles per loop, and take cue times
modulo the loop length.

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
