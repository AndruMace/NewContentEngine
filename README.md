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
paste post links to keep track of where it went. The equivalent CLI command is shown underneath.

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
5. After posting, paste the post URLs into the upload page or the card, to keep track of where each video went.

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
| `automata-3d` | kinetic | 3D cellular automata in voxels, one per video (`mode`). Crystal growth: a tiny symmetric seed (none, 8- or 48-fold) grows under a 3D rule (Crystal Growth, Frost, Snowflake, 445, Builder, Shells, Expanding Shell, Coral, Amoeba, Pyroclastic) into a gem or coral with no walls, for hundreds of generations: until it dies, settles, or reaches the generation count or its size budget (automatic runs stop at about 3 s of simulation). Life tower: Game of Life (or HighLife, Day & Night, Mazectric) from a famous pattern (R-pentomino, Acorn, Diehard, glider gun…) on an endless board (or a torus), with every generation stacked into a tower; patterns run their true lifetimes (Acorn's 5,206 generations), generations speed up so they still finish on time, then the camera pulls back on the whole sculpture. Colony war: 2–4 colonies spread through a sphere or cube and fight for cells at their borders (majority, or rock-paper-scissors), with a rotating cutaway, a live share bar and a shrinking final rush. Optional text: the run's rules at the bottom, and plain-words captions at the top that describe what this run is doing as it happens. Looks: glossy, clay, neon |
| `who-would-win` | race | 3D low-poly "who would win": real animals, mythical creatures and fighters (Lion, Tiger, Grizzly, Gorilla, Crocodile, Rhino, Elephant, Bull, Horse, Unicorn, Stag, Deer, Donkey, Alpaca, Wolf, Husky, Fox, Swordsman, King, Brawler, Viking, Minotaur, Troll, Dragon, Griffin, Giant Spider) battle in a colosseum. Each has stats (size, power, speed, strength, toughness), a hide that resists some kinds of blow (bites, claws, blows, fire) and a signature trait. Blows physically connect (the striking part lands on the spot it hits), leave stylized wounds and add up to injuries (limping, dazed, winded, a torn wing); fighters lock horns or grapple and shove each other aside, get knocked down, block with shields. Duel: VS card with stat bars, hide and trait, HP bars with injuries, hit freezes, staggers and damage numbers, a knockout and its instant replay. Horde: how many of a small kind it takes to beat a big one, let in through the gates one after another. Teams: two on two. Tournament: four fighters, two semi-finals and a final, with a bracket between fights (any fight can play as fast-forwarded highlights). Gauntlet: one challenger against a ladder of ever tougher opponents, full health each fight, until it loses. Pound for pound: the smaller fighter grows to the bigger one's weight. A fury meter fills as fighters trade blows and unleashes each one's named finisher. Every fighter is modelled and animated in code (`who-would-win/proc/`: skinned spines, IK legs and arms, gaits, wings, held swords; grapples such as latching on, mauling and death rolls), with synthesized combat sound (impacts, bites, slashes, roars, hooves, crowd) and an optional soundtrack: the melody at its own tempo over bass and battle drums; balance check: `npx tsx scripts/battle-matrix.ts` |
| `genetic-drift` | kinetic | Narrated biology: beetles, flowers, fish, marbles or cells in a few colours; every generation each copies one random parent, and one colour takes over by luck alone. Colour race, drift vs selection (a fitter colour can still lose), small vs large populations, a bottleneck crash, a lucky mutant (one in N). Family-tree view for small populations, grid for big ones, share chart |
| `plant-rules` | kinetic | Narrated L-systems: one rewriting rule on screen grows a fern, bush, tree, seaweed, grass or flowering plant round by round as its line count explodes; sweep the branch angle, a garden of rules with chance (every plant unique), or fractals (dragon curve, Koch snowflake, Sierpinski triangle, Hilbert curve). Seasons, wind, leaves, flowers |
| `chladni-plates` | particles | Narrated physics: sand on a plate gathers on the lines that stay still, one Chladni figure per note. Physically modelled: real free-edge plate modes (square by Rayleigh–Ritz, round by Bessel functions, checked against Leissa's tables) at the real frequencies of a plate of the chosen metal, size and thickness; a speaker under the centre plays only figures in which the centre moves, a violin bow on the edge plays the rest. Rising pitch, guess the pattern, same note on a square vs a round plate |
| `space-drop` | kinetic | Narrated physics: something falls from space and hits the ground, with live altitude, speed (and Mach), surface and shock-layer temperature and g-force, then the impact energy (as TNT and against things people know), crater and quake magnitude. A tungsten rod of any mass (point-first or tumbling), vehicles (car, pickup, school bus, battle tank, jumbo jet, shipping container), penny, bowling ball, anvil, grand piano, fridge, cow, iron and stony meteorites, a Chelyabinsk-size asteroid, a dead satellite, a station module, a blue whale, a house, a cruise ship, the Eiffel Tower as a steel cube. Dropped from rest, de-orbited at an entry angle, or arriving as a meteor. Physically modelled: US Standard Atmosphere 1976 to 1,000 km around a spinning Earth, Mach- and rarefaction-dependent drag, Sutton–Graves and Tauber–Sutton heating, heat conducted into the surface, melting and ablation, breakup when ram pressure beats its strength or its skin burns through, rocks pancaking into airbursts (Chelyabinsk comes out at ~25 km, ~370 kt), Holsapple crater scaling. The clock runs hundreds of times fast through the coast and slows to real time (or slow motion) for the impact. Solo, or Versus with 2–3 objects side by side |
| `murmuration` | particles | Narrated emergence: a 3D murmuration of starlings (or a fish school) from three rules (separation, alignment, cohesion) switched on one at a time, a falcon attack, guess the missing rule, or seven neighbours (one swerve ripples through the flock) |
| `slime-mold` | particles | Narrated biology: a slime mold (Physarum) as tens of thousands of trail-laying agents links oat flakes into a network (vs the shortest one), solves a maze, explores then prunes, or redraws the cities around Tokyo (the 2010 experiment, approximate map) |
| `tower-stack` | kinetic | The daily stacking puzzle, shown as if a person were playing it: named toy pieces (Bridge, Step, Notched beam, Counterbeam, Mesa, Ramp…) come one at a time and a cursor drags, turns and drops each one, with human-varied timing and drop heights. Behind the scenes it test-drops every spot and quarter turn with real physics before committing, builds a broad base first and goes for height over the last pieces; deep settled pieces lock in place so the cost stays flat as the tower grows. Now and then the tower goes over: a heart is lost and it rewinds to the last steady tower. A ruler climbs the side with real things to beat (a corgi, a fire hydrant, an emperor penguin, a door). Daily (N pieces) or endless (until the falls run out; skill 1 never misjudges there); classic, blocky or wild piece sets; day or night look |

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
is repeated to the final length without re-encoding. These templates are kept out of batches and
the planner entirely.

| Template | What happens |
|---|---|
| `cabin-storm` | Inside a log cabin: a stone fireplace with a crackling fire between two big windows, a thunderstorm (or snow) outside with swaying pines, rain on the glass, and lightning that throws the window shapes across the floor. Settings: storm, lightning per hour, thunder volume, fire size, rain or snow, rain sound |
| `orbital-viewport` | Looking out of a spaceship's viewport at a large planet turning below (earthlike, ocean, desert, ice or a gas giant), clouds drifting and reshaping, an atmosphere glowing at the horizon, the occasional shooting star; optional rings and moons; cool, amber or red cabin lighting; the ship's room tone and hum with soft console blips |
| `night-train` | A sleeper compartment at night: walnut panelling, a table lamp under the window, pillows on the berth. The countryside slides past (hills with town lights, farms, tree lines), with stations it slows through, level crossings with their bells, bridges and tunnels; rain on the glass, snow streaming past, or a clear moonlit night. The track is a ring exactly one loop long, so the wheels' clickety-clack keeps its rhythm across the join. Settings: weather, intensity, speed, jointed or welded track, lights, crossings/bridges/tunnels per hour, horn, lamp |
| `day-train` | A day on a train through storybook country: a first-class compartment (walnut, brass, blue velour benches) with a big window. Outside, a real 3D land: rolling green hills, patchwork fields with hedgerows, woods and lone trees (with their shadows), villages of half-timbered and thatched cottages round a church, windmills, walled towns with castles and spires on the hilltops, castles on crags, now and then a city on a far ridge; stone-arched river valleys under the bridges, tunnels, country stations, level crossings. Painterly, stylized shading. Sunny at midday or in a golden afternoon, or rain. The ring of track is a whole number of 4800 m, so every band of scenery loops. Settings: weather, time of day, rain intensity, speed, jointed or welded track, villages, castles/towns/cities, crossings/bridges/tunnels per hour, horn, seat facing |
| `deep-sea` | Deep Sea Submarine: the pilot's seat of a small submarine cruising forward through the ocean, a big acrylic dome in front, the console's green-lit dials, meters and sonar scope glowing in the dark. Twilight zone (lanternfish, squid, red octopuses, a swordfish, mantas, a blue shark, a whale far off, singing), abyss (anglerfish, gulper eels, vampire squid, dumbo octopuses, a sixgill shark, sparkles, lit by the headlights) or sunlit reef (reef fish shoals, sea turtles, rays, a reef shark, caustics over coral). A few jellyfish everywhere, swimming in pulses. Settings: depth, marine life, whales per hour, headlights, marine snow, sonar, creaks, cruising speed |

**In the app:** open the **Ambient** tab. Pick a scene, a seed and its settings, and watch the
16:9 preview with its sound; the scrub bar covers the whole master loop (it plays on from the top
at the end). Choose the loop length (20–60 min) and the final length (1–12 h), add optional notes
for Claude, and press **Render**. Renders queue behind any Shorts in the render queue and keep the
Mac awake while they run (`caffeinate`). Each one shows its stage, progress and time left.
**Cancel** stops after the current 5-minute segment, and **Retry** resumes from there; a server
restart resumes on its own. While it renders, Claude writes the YouTube title, description, tags
and thumbnail text (plain copy without an API key). Each field can be copied, edited, or rewritten
with new notes. When it's done the card has the video, its thumbnail, the QC result and size, and
**Show in Finder**. Uploading is manual (YouTube only). They also appear under **All renders**
with a *Long-form* label.

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

### Narrated templates

Templates built around a voiceover use the story kit in `packages/templates/src/story/`. The
video is a `Script` of directives counted in sim ticks (`say`, `play`, `until`, `act`, `hold`),
and a `Director` plays it back: a line lasts as long as it takes to say, and the sim covers a
fixed number of ticks while it's said. So the sim is in the same state at every tick whatever the
line lengths, the facts the writer sees are the facts on screen, and each line starts exactly as
its moment does. `play(..., { elastic: true })` stretches are sped up or slowed down to land near
`targetS`, and lines are never cut. A beat with `parts` is written and voiced sentence by
sentence (one clip, with each sentence's start known), for things that must happen as a sentence
begins. Narration is off by default (so the Playground never writes or voices lines until
asked); off, the same script plays with its lines as captions.

## Music

Only public-domain compositions, transcribed by hand in `packages/audio/src/melodies.ts`
(never copied from MIDI sites, whose arrangements can be copyrighted).

## Debug scripts

```bash
npx tsx scripts/survey.ts <template> <seeds> <targetS> '<params json>'   # duration + score spread
npx tsx scripts/compare-events.ts data/renders/<day>/<id>              # browser vs Node event log
npx tsx scripts/diff-events.ts data/renders/<day>/<id>                 # first divergent event
```
