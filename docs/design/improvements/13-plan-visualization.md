English | [繁體中文](13-plan-visualization.zh-TW.md)

# 13 — Opt-in plan visualization

**Status: implemented.** `planVisualization` on `StageDefSchema`
(`packages/core/src/manifest/schema.ts`), `planVisualizationBlock` in
`workflow/verdict.ts`, `planVisualizationFor` in `config.ts` plus the
`workflows.<kind>.planVisualization` knob, the compose tail in
`workflow/engine.ts`, mermaid rendering in the hub
(`packages/hub/src/web/markdown/MermaidBlock.tsx` + `mermaid-embed.ts`);
tests in `schema.test.ts`, `config.test.ts`, `verdict.test.ts`,
`engine.test.ts`, `parse.test.ts`, `mermaid-embed.test.ts`.

## Context

The plan gate asks a human to approve the *shape* of a change from prose
alone. For certain shapes — state/lifecycle transitions, flows spanning
several packages, concurrency and locking, data-shape changes — prose hides
exactly the defect class the reviewer needs to catch: this repo's own worst
bugs were missing-arc bugs (a claim-release path a stop handler skipped, an
orphan sweep that never fired), which a state diagram makes visible and a
numbered step list does not. Yet a diagram forced onto every plan is review
noise on the mechanical majority, and a second artifact that can drift from
the steps it illustrates.

## Design

- `planVisualization: z.boolean().default(false)` on the stage schema (the
  `planContract` pattern — opt-in per stage, default keeps every kind
  byte-identical). A `check` stage setting it is a manifest error, and so is
  setting it without `planContract`: the diagram lives inside the
  `## Implementation Plan` document the contract defines.
- Config `workflows.<kind>.planVisualization` (kind-level boolean) wins over
  the manifest flag in both directions, resolved by `planVisualizationFor` —
  the shipped manifests are inside the core package, so config is the only
  reachable opt-in (the `stageFanout` rationale). Kind-level rather than
  stage-keyed because at most one stage per kind carries `planContract`, which
  the resolver requires. One boolean — repo-layer safe, like `stageContext`.
- `planVisualizationBlock` (in `verdict.ts`, beside `planContractBlock` — a
  contract stated only in a persona is skippable; one appended at composition
  survives every dispatch path) states the heuristic: include ```mermaid``
  fence(s) inside the plan when the change involves state/lifecycle
  transitions, cross-package flow, concurrency/ordering, or data-shape
  changes; skip it for small or mechanical plans; the numbered steps are
  authoritative on any disagreement. SHOULD, never MUST — and `runPark` is
  untouched.
- The hub renders the fence as a diagram: `Markdown.tsx` routes
  `lang === "mermaid"` code blocks to `MermaidBlock`, which lazy-imports
  mermaid (an esbuild split chunk — fetched only when a document has a
  diagram) and renders the SVG inside `<iframe sandbox="" srcdoc>`. The
  iframe is the security boundary, not mermaid's sanitizer: mermaid is
  internally innerHTML-based with a history of bypass CVEs, and the renderer's
  no-`dangerouslySetInnerHTML` invariant must hold for repo content that
  arrived on someone else's branch — a scriptless, origin-less frame holds it
  even under a full bypass. `securityLevel: "strict"` stays on as defense in
  depth. The block keeps its id, so per-line replan comments anchor to the
  diagram like any other block; a source toggle and a `<pre>` fallback on
  render failure keep the plan text always readable.

## Why not

- **Enforcing a diagram at the park gate** — a diagram's worth is a
  prose-quality judgment; a regex can only check that a fence exists, which
  invites a decorative diagram on every plan and the livelock economics the
  plan-contract record already documents.
- **Draft-stage diagrams** — a draft is 1–4 sentences plus acceptance
  criteria by schema (`workflow-task-author` writes nothing below the body);
  there is no shape to draw yet. Epics' slice maps were considered and
  deferred.
- **Rendering mermaid into the hub DOM with DOMPurify** — a sanitizer is a
  blocklist race against mermaid's CVE history; the sandboxed iframe is a
  capability boundary that does not depend on winning it.
- **A stage-keyed config record** (`stageVisualization: {plan: true}`) — the
  resolver keys off `planContract`, which at most one stage per kind carries;
  a record would imply a per-stage choice that cannot exist.
