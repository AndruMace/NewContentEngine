/**
 * How to write the published text, shared by the batch planner and the export copy writer. Written
 * around what each piece of text has to make a viewer do, because the model otherwise defaults to
 * describing the video.
 */
export const COPY_GUIDE = `How the published text earns reach:
On YouTube Shorts, TikTok and Instagram Reels, people find videos in the feed, not by searching. They read the text in about a second while the video is already playing, so the text never needs to explain the video: the video explains itself. Its job is to make someone keep watching to the end, watch again, comment, share or follow, because those are what the platforms reward with more reach.

What works:
- An open question or tension that the ending pays off ("how far does it get?", "who's still spinning at the end?").
- A side to pick or a guess to make before it starts: people who have picked stay to see if they were right, and then comment.
- A challenge to the viewer ("bet you can't call this one", "don't blink at the end").
- One specific detail (a number, a matchup, a name) rather than a general description.
- Sounding like a person posting their own video, not a catalogue listing.

What doesn't work:
- Describing the setup ("A ball bounces inside 18 spinning rings…") or listing features (neon, music, physics simulation). The viewer can already see all of that.
- Label titles strung together with "|", ":" or "–" ("Ball Escapes 18 Rings | Satisfying Physics Simulation").
- Repeating the on-screen hook word for word: it is already on screen, so the title and captions add a second angle instead.
- The same structure every time (every title starting with "Can…").

Examples (patterns, not wording to reuse):
- Weak: "Spinning Top Battle: Attack vs Defense, Country Flags Clash in a Neon Stadium" (a label of what's on screen). Stronger: "Attack or Defense? Pick before the 3-2-1 ⚔️"
- Weak: "Ball Escapes 18 Rotating Rings | Satisfying Physics Simulation" (a label, and it gives away the ending). Stronger: "How many rings does it get through? Guess before it starts 👀"
- Weak caption: "18 spinning rings. One tiny ball. Every bounce is a note." Stronger: "Not me holding my breath for the last ring 😮‍💨"
- Weak pinned comment: "What did you think of this video?" Stronger: "Drop your guess: what ring number? 👇" (answerable in one word or emoji, so far more people reply)

Ground rules:
- Never spoil the ending: don't name the winner or a mystery answer, and don't say how it finishes (that includes titles like "Ball escapes…"). Don't assume how it finishes either, anywhere: no "that final hit" when it might end on a spin-out, no "the ring it gets stuck on" when it might escape.
- The outcome is decided by real physics, so never claim something the video might not show (no made-up stats, no "it gets stuck on ring 17").
- Keep strategy talk (retention, hooks, engagement, "viewers") out of everything published.
- Hashtags are for reaching people who'd enjoy this exact video: one or two broad tags plus specific ones for the format and subject. Never tags about the tools used (no #claude, #ai, #anthropic), and none from an unrelated niche.`;

/** Per-platform behaviour, for the export copy writer's system prompt and the field descriptions. */
export const PLATFORM_GUIDE = `Per platform:
- YouTube Shorts: the title shows over the video in the feed and gets cut off around 40 characters on phones, so the first few words carry it; keep it under 60. The description is rarely read in the feed but feeds search and suggestions: one line in your own voice, then one natural sentence with the phrase people would search for ("marble race", "satisfying ball escape").
- TikTok: the caption sits under the playing video. Short (under about 100 characters before the hashtags) and conversational, like a creator talking to the camera: a challenge, a "POV", a question. TikTok search reads captions, so one natural keyword helps.
- Instagram Reels: only the first line (about 125 characters) shows before "more", so it must work alone. Reels reach grows with shares and saves. A "send this to…" line only fits when the video has a natural rivalry or someone to tag (countries, a matchup) and should be the exception, not a closing formula.
- X: a post with the video attached. One or two short lines that read like a person's opinion or question, something people want to reply to or quote. Hashtags help little on X: one at most.
- Pinned comments and the X reply: something answerable in one word, number or emoji (a guess, a pick, a rating), different on each platform.
- Cover text: 2-5 words readable at thumbnail size that make people tap: a question, a stake or a dare, not a description of how the video works. Different from the title, never the ending.`;
