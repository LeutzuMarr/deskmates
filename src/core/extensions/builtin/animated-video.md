---
name: animated-video
description: Timeline-based motion design — animated videos, motion graphics, kinetic type, animated explainers and social clips, built on the motion-stage engine and exported to MP4, WebM or GIF.
---

# Animated video

Use this for any piece whose main content is motion: an animated video, motion graphics, a title sequence, kinetic typography, an animated chart or explainer, a product teaser, a looping social clip, an animated logo reveal.

## Workflow

1. **Pin the brief.** Format and aspect (16:9 1920×1080 for video, 1080×1080 square, 1080×1920 vertical for stories/reels), length (most pieces are 6–30 s), the message, and the mood. Ask only if a wrong guess would waste the work.
2. **Write the scene list first.** Each scene is one idea with a name and a duration in seconds. Total length = sum of durations. Typical beats: hook (1.5–3 s), 2–4 content scenes (3–5 s each), outro/CTA (2–3 s).
3. **Copy the engine:** `copy_starter_component({ kind: "animations_v3.jsx" })` → `motion-stage.js` in the design folder. Build the piece in one page (a plain `Name.html` page, or a Design Component with the script in `<helmet>`).
4. **Build the frame, then the motion.** Lay every element out at its resting position first (absolute `left`/`top` on a fixed canvas), check a still with a screenshot, then add entrances, exits and moves.
5. **Check it.** Take screenshots at a few times (`document.querySelector('motion-stage').seek(4.2)` in a script step before the capture) — especially scene boundaries — and fix overlaps or empty frames.
6. **Show it** with `show_to_user`; the preview plays it with a timeline scrubber (Space plays/pauses, ←/→ step a frame, Shift+←/→ a second).
7. **Export** when asked (or when a video file is the deliverable): `export_video({ path: "Name.html" })` → `exports/Name.mp4`. `format: "gif"` for a GIF, `"webm"` for WebM. The stage's size, frame rate and length are used unless you pass others.

## Page skeleton

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Launch teaser</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700;900&display=swap">
  <script src="motion-stage.js"></script>
  <script>
    window.MOTION_SCENES = '[{"name":"Hook","duration":2.5},{"name":"Feature","duration":4},{"name":"Outro","duration":3}]'
  </script>
  <style>body { margin: 0; font-family: Inter, sans-serif; }</style>
</head>
<body>
  <motion-stage width="1920" height="1080" fps="30" background="#0e0e0d">
    <h1 style="position:absolute; left:160px; top:400px; margin:0; font-size:140px; color:#f4f1ea"
        data-in="fade-up" data-in-at="Hook+0.2" data-out="blur" data-out-at="Hook.end-0.4">Meet Orbit</h1>
    <div style="position:absolute; left:160px; top:380px; width:900px; font-size:64px; color:#f4f1ea"
         data-scene="Feature" data-in="type" data-in-dur="1.4">Plans your week in one tap.</div>
    <div style="position:absolute; left:1100px; top:240px; width:600px; height:600px; border-radius:48px; background:#d97757"
         data-motion="t:Hook; scale:0; rotate:-20 | t:Hook+0.9; scale:1; rotate:0; ease:outBack | t:Feature; x:0 | t:Feature+1; x:-80; background-color:#4f7cff; ease:inOutCubic | t:Outro+0.5; scale:0.2; opacity:0; ease:inExpo"></div>
  </motion-stage>
</body>
</html>
```

## The engine

`<motion-stage width fps background duration loop autoplay controls>` — a `width`×`height` canvas scaled to fit the window. `duration` defaults to the sum of the scenes; `loop="false"` stops at the end; `controls="none"` hides the scrubber. The scrubber and keyboard control never show in exports.

**Scenes:** `window.MOTION_SCENES = '[{"name":"…","duration":seconds}, …]'` — a JSON *string* in a plain inline script (or the `scenes` attribute, or `<script type="application/json" id="motion-scenes">`). Scenes play back to back.

**Times** (in `t:`, `data-in-at`, `data-out-at`): `2.5` (seconds from the start) · `Feature` (scene start) · `Feature+0.4` · `Feature-0.2` · `Feature.end` · `Feature.end-0.5` · `Feature@50%`.

**Keyframes — `data-motion`:** keyframes separated by `|`, properties by `;`:
`data-motion="t:Hook; opacity:0; y:60 | t:Hook+0.6; opacity:1; y:0; ease:outCubic"`
(a JSON array of keyframe objects also works). Before the first keyframe an element holds the first values, after the last it holds the last. `ease` on a keyframe shapes the movement *into* it (default `inOutCubic`).

**Properties:** `x`, `y` (px, or with a unit) · `scale`, `scaleX`, `scaleY` · `rotate`, `skewX`, `skewY` (deg) · `opacity` · `blur` (px) · `reveal` / `revealY` (0–1 wipe from the left / top) · `typewriter` (0–1 of the element's text) · any CSS property: `color`, `background-color`, `width`, `height`, `border-radius`, `letter-spacing`, `font-size`, `--custom-var`… Numbers with the same unit and colors (`#hex`, `rgb()`) interpolate; other values switch at the keyframe.

**Easings:** `linear`, `in`/`out`/`inOut` + `Quad Cubic Quart Quint Sine Expo Circ Back Elastic Bounce` (e.g. `outExpo`, `inOutBack`, `outElastic`), `spring`, `ease`, `easeOut`, `cubic-bezier(0.2,0.8,0.2,1)`.

**Presets:** `data-in="…"` (entrance) and `data-out="…"` (exit): `fade fade-up fade-down slide-left slide-right scale pop blur wipe wipe-up type`. Set the time with `data-in-at` / `data-out-at`, the length with `data-in-dur` / `data-out-dur` (default 0.6 s), the easing with `data-in-ease` / `data-out-ease`.

**Scenes on elements:** `data-scene="Feature"` shows the element only during that scene; its `data-in` then defaults to the scene start and `data-out` to the scene end. **Stagger:** `data-stagger="0.08"` on a parent offsets its children's default entrance times — perfect for lists, word-by-word titles and grids.

**Custom motion in script:** `stage.onFrame((time, info) => { … })` runs every frame (`info.scene`, `info.sceneTime`, `info.progress`) — use it for counters, canvas drawing, charts or anything computed. Use the time you're given, never a clock of your own, so the export matches the preview. `Motion.tween(time, [t0, t1, t2], [a, b, c], 'outCubic')` and `Motion.ease.outBack(p)` help. `stage.play()`, `pause()`, `seek(s)`, `stage.time`, `stage.duration`, `stage.scenes`.

Plain CSS `@keyframes`, `setTimeout`, `requestAnimationFrame` and Lottie/GSAP also export correctly (the exporter controls the page clock), but the stage's timeline is what the scrubber and scenes show — prefer it.

## Motion craft

- **One idea per scene**, readable in the time given: ~3 words per second of on-screen text at most.
- **Enter fast, settle slow:** entrances 0.4–0.8 s with `out` easings (`outCubic`, `outExpo`, `outBack` for playful); exits shorter (0.25–0.4 s) with `in` easings. Avoid `linear` except for continuous drifts and typing.
- **Stagger** related elements by 60–120 ms instead of moving everything at once; lead with the most important element.
- **Continuity:** carry an element across scene boundaries (the same shape moving/morphing into the next layout) instead of cutting everything; overlap the outgoing exit with the incoming entrance by 0.1–0.3 s.
- **Hold** the final state long enough to read (≥1 s) — especially the CTA/logo at the end.
- **Hierarchy through motion:** big moves for the hero, subtle 10–30 px moves for supporting text. Keep secondary motion (slow drifts, parallax) small so it never competes.
- **Safe area:** keep text 80–120 px from the edges of a 1920×1080 frame (proportionally for other sizes); nothing important under typical captions at the bottom of vertical formats.
- Use real, specific copy and a deliberate palette and type pairing — the same visual standards as any design.
