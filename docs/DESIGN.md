# Design system

The dashboard's visual language is assembled from the curated resources in
[`maxbogo/awesome-ai-tools-for-ui`](https://github.com/maxbogo/awesome-ai-tools-for-ui).
Each influence is named so the reasoning is auditable rather than vibes.

| Influence (from the list) | What was taken | Where it shows |
| --- | --- | --- |
| **Impeccable** — design commands about typography, spacing, hierarchy | One accent colour, a 5-step type scale, spacing on a 4 px grid | `styles.css` tokens `--radius*`, `--accent`, type sizes 11/12/13/15/28 |
| **UI UX Pro Max** — design-system generation by project type | "Utility/tool" profile: dense but calm, tabular numerals, no illustration noise | `.job-bottom { font-variant-numeric: tabular-nums }` |
| **Make Interfaces Feel Better** — small compounding details | 120–180 ms transitions only on state change, 1 px press translate, `:focus-visible` rings, `prefers-reduced-motion` kill-switch | `.btn:active`, `.job` rise, media query at the bottom of `styles.css` |
| **shadcn/ui** — restrained component primitives | Button/Card/Pill/Chip built as tokens-first CSS classes, not a component library | `.btn`, `.card`, `.pill`, `.chip` |
| **Realtime Colors** — palette previewed in a real mockup | Dark and light ramps derived from one green accent + neutral blue-grey ramp | `--bg*`, `--panel*`, `--text*`, light theme block |
| **Transitions.dev** — interaction patterns | Progress fills animate linearly at the data cadence, never bounce | `.segbar .seg i { transition: width 220ms linear }` |
| **SVG Loaders / Book of Shapes** | Hand-authored inline SVG (brand mark, empty state, icons) — zero icon-font dependency | `index.html` inline `<svg>` |
| **22.dev / prompt-kit** (component thinking) | Status is a word *and* a colour, never colour alone (a11y) | `.status-pill` text + `data-s` |

## The signature element: per-connection segments

A download manager's identity is *parallelism made visible*. Instead of one
progress bar, each transfer renders one cell per connection, each cell filled by
that segment's own cursor. When a pause happens mid-flight the cells freeze in
place — the UI literally shows the resume state that makes the product useful.

```
[██████████][████████████][██████······][██████████████]   ← 4 connections
     100%          100%         42%            100%
```

Implementation: `renderJob()` in `apps/web/public/app.js` rebuilds the cell count
only when the segment count changes, then updates only `width` — no layout thrash
on a 200 ms tick.

## Tokens

```
bg #0b0f14 · panel #141a22 · line #222c37 · text #e9eef5
accent #4ade80 (+ --accent-soft, --accent-ink)
warn #fbbf24 · danger #f87171 · info #60a5fa
radius 10 / 14 / 18 px · shadow = 1px inset highlight + 32px ambient
```

Light theme is a token swap only (`html[data-theme='light']`) — no component
overrides, so dark/light parity is structural, not cosmetic.

## Accessibility

- Every control is reachable by keyboard; `/` focuses the URL field, `:focus-visible` rings are 2 px.
- Status uses text + colour (`.status-pill`), never colour alone.
- The queue is a list (`<ul>/<li>`), filters are `role="tab"` with `aria-selected`.
- Live regions: `#toasts` (`aria-live="polite"`), `#probe` (`aria-live="polite"`).
- Motion respects `prefers-reduced-motion`; the sparkline is decorative (`aria-hidden`).
- Contrast: text on `--panel` is ≥ 7:1 in dark, ≥ 4.6:1 in light for body copy.

## Screens

| File | Viewport | Notes |
| --- | --- | --- |
| `docs/screenshots/dashboard-dark.png` | 1440 × 940 | mixed queue, live throughput |
| `docs/screenshots/dashboard-light.png` | 1440 × 940 | same layout, token swap |
| `docs/screenshots/dashboard-mobile.png` | 430 × 900 | single column, stacked actions |
