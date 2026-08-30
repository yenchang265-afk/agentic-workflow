# Performance Checklist

The **optimizing** branch of web application performance: how to measure a real
running system and fix what the measurement names. The `performance-optimization`
skill carries the **judging** branch — finding unbounded work in a diff you
cannot run — and points here.

Everything below is what a frontier model does not reliably reach for unaided:
the field thresholds, the scheduling and bfcache levers, and the budget. The
ordinary controls — WebP, `loading="lazy"`, joins instead of N+1, pagination,
code splitting, `transform`/`opacity` animation, connection pooling — are
assumed, and appear here only where a number or a gotcha rides on them.

## Core Web Vitals targets

| Metric | Good | Needs work | Poor |
|--------|------|------------|------|
| LCP (Largest Contentful Paint) | ≤ 2.5s | ≤ 4.0s | > 4.0s |
| INP (Interaction to Next Paint) | ≤ 200ms | ≤ 500ms | > 500ms |
| CLS (Cumulative Layout Shift) | ≤ 0.1 | ≤ 0.25 | > 0.25 |

TTFB over 800ms is itself the finding, and the waterfall says which third of it
to attack: DNS and connection setup (`preconnect`, `dns-prefetch`, HTTP/2,
keep-alive), or server processing (profile, index, cache).

## Measure the layer the symptom names

The symptom picks the first measurement, so that you profile the layer that is
actually slow rather than the one you suspect:

| Symptom | First measurement |
|---|---|
| Slow first load | Bundle size and the network waterfall — render-blocking CSS/JS, then TTFB |
| Sluggish interaction | Performance trace for long tasks (> 50ms) attributed to the input |
| Layout jank | Layout-shift attribution, then forced synchronous layout in the trace |
| Slow endpoint | The database query log for that route — N+1 and missing indexes first |
| All endpoints slow | Connection pool saturation, memory, CPU |
| Intermittent slowness | Lock contention, GC pauses, and the external dependencies on the path |
| Memory growth | Heap snapshot diff — leaked listeners, unbounded caches |

**Synthetic and field data answer different questions.** Lighthouse and the
DevTools Performance panel are reproducible, so CI regression gates and issue
isolation run on them; RUM (`web-vitals`, CrUX) is the only thing that confirms
real users got faster. Check field INP before optimising an interaction, and
test on a mid-range Android or 4×–6× CPU throttling — INP problems often exist
only on slow hardware.

```typescript
// Interaction-level attribution — which phase of INP to attack
import { onINP } from 'web-vitals/attribution';
onINP(({ value, attribution: { interactionTarget, inputDelay, processingDuration, presentationDelay } }) =>
  console.log({ value, interactionTarget, inputDelay, processingDuration, presentationDelay }));
```

## Main-thread scheduling (the INP lever)

- [ ] Long tasks broken up so input can run between chunks — `scheduler.yield()` where available, `scheduler.postTask()` for prioritised work, `isInputPending()` to yield only when something is waiting
- [ ] `requestIdleCallback` for deferrable work (analytics flush, prefetch, warmup)
- [ ] Non-critical work moved out of the event handler, so the visible response is not behind it
- [ ] Heavy computation offloaded to a Web Worker
- [ ] `React.memo` / `useMemo` / `useCallback` applied where a profile shows the win, not pre-emptively

## Loading and rendering

- [ ] LCP image `fetchpriority="high"` and never lazy-loaded; everything below the fold `loading="lazy" decoding="async"`
- [ ] Every image and `<source>` carries explicit `width`/`height` — the art-directed case is where CLS usually escapes
- [ ] `fetchpriority` also on critical non-image resources (a key `preload`, an above-the-fold script)
- [ ] Off-screen sections use `content-visibility: auto` with `contain-intrinsic-size`
- [ ] bfcache eligibility preserved — no `unload` handlers, no `Cache-Control: no-store` on HTML
- [ ] Long lists virtualized
- [ ] Static assets content-hashed and served with a long `max-age`

## Fonts

- [ ] 2–3 families, 2–3 weights each — every extra weight is another request
- [ ] WOFF2 only, self-hosted (a third-party font CDN adds DNS + TCP + TLS)
- [ ] LCP-critical faces preloaded: `<link rel="preload" as="font" type="font/woff2" crossorigin>`
- [ ] `font-display: swap`, or `optional` for non-critical faces
- [ ] Subset with `unicode-range`; a variable font where several weights are needed
- [ ] Fallback metrics matched with `size-adjust`, `ascent-override`, `descent-override` so the swap does not shift layout

## Budget

Enforced in CI, so a regression fails the build instead of waiting for a user:

```
JavaScript bundle: < 200KB gzipped (initial load)
CSS: < 50KB gzipped     Images: < 200KB above the fold     Fonts: < 100KB total
API response time: < 200ms (p95)     Time to Interactive: < 3.5s on 4G
```

A diff that breaks a budget the repo actually defines is a review finding — see
`code-review-and-quality` → Severity.

Tree-shaking is not one of these levers: modern bundlers handle named imports
already, provided the dependency ships ESM and marks `sideEffects: false`. The
wins are splitting and lazy loading, so profile before rewriting import styles.
