import { LoopManifestSchema, type LoopManifest, type WorkSourceBinding } from "@agentic-loop/core/manifest/schema"

/**
 * Starter templates for the new-kind landing screen — one valid manifest
 * skeleton per work-source type, each a simplified echo of the shipped kind
 * of the same shape (engineering, pr-sitter, dep-sitter, main-sitter).
 * `manifest` is a factory that parses on every call: parsing materializes the
 * schema defaults `fromFlow` mirrors (exact round-trips), and a fresh object
 * per open keeps template constants out of live editor state.
 */

export interface LoopTemplate {
  /** The workSource type this template is built around; doubles as the card's source tag. */
  readonly id: WorkSourceBinding["type"]
  readonly label: string
  readonly description: string
  readonly manifest: () => LoopManifest
}

/** "work → verify" — the card's stage-chain preview line. Pure. */
export const stageChain = (manifest: LoopManifest): string => manifest.stages.map((s) => s.name).join(" → ")

export const TEMPLATES: readonly LoopTemplate[] = [
  {
    id: "backlog",
    label: "Backlog loop",
    description: "Drive docs/tasks backlog items through work and verification.",
    manifest: () =>
      LoopManifestSchema.parse({
        kind: "my-backlog-loop",
        version: 1,
        description: "Drives queued backlog tasks through work and verification.",
        workSource: {
          type: "backlog",
          statuses: ["queued", "in-progress", "completed"],
          pools: [{ status: "queued", entryStage: "work" }],
        },
        maxIterations: 3,
        stages: [
          { name: "work", kind: "work", command: "work", agent: "loop-work", prompt: "stages/work.md" },
          { name: "verify", kind: "check", command: "verify", agent: "loop-verify", prompt: "stages/verify.md" },
        ],
        transitions: {
          work: { onDone: { kind: "fire", stage: "verify" } },
          verify: {
            onPass: { kind: "done", toStatus: "completed", message: "✓ Work verified." },
            onFail: {
              kind: "fire",
              stage: "work",
              countIteration: true,
              capMessage: "✗ Gave up after {maxIterations} iterations.",
            },
            onError: { kind: "stop", message: "✗ Verification errored — investigate manually." },
          },
        },
      }),
  },
  {
    id: "github-pr",
    label: "PR sitter",
    description: "Sit on your open PRs — triage, fix, verify, reply. Never merges.",
    manifest: () =>
      LoopManifestSchema.parse({
        kind: "my-pr-loop",
        version: 1,
        description: "Sits on open pull requests: triages activity, fixes what's actionable, verifies, and replies. Never merges.",
        workSource: {
          type: "github-pr",
          query: "is:open author:@me",
          triggers: ["failing-checks", "changes-requested", "new-comments", "merge-conflict"],
          role: "author",
        },
        maxIterations: 3,
        stages: [
          { name: "triage", kind: "check", command: "triage", agent: "loop-triage", prompt: "stages/triage.md", isolation: "none" },
          { name: "fix", kind: "work", command: "fix", agent: "loop-fix", prompt: "stages/fix.md" },
          { name: "verify", kind: "check", command: "verify", agent: "loop-verify", prompt: "stages/verify.md" },
          { name: "publish", kind: "work", command: "publish", agent: "loop-publish", prompt: "stages/publish.md" },
        ],
        transitions: {
          triage: {
            onPass: { kind: "fire", stage: "fix" },
            onFail: { kind: "done", message: "✓ Nothing actionable on this PR right now." },
            onError: { kind: "stop", message: "✗ Triage could not inspect the PR — fix the environment and let the next poll retry." },
          },
          fix: { onDone: { kind: "fire", stage: "verify" } },
          verify: {
            onPass: { kind: "fire", stage: "publish" },
            onFail: {
              kind: "fire",
              stage: "fix",
              countIteration: true,
              capMessage: "✗ Verify failed after {maxIterations} iterations. The PR parks until a human pushes a new head.",
            },
            onError: { kind: "stop", message: "✗ Verify could not run (environment/infrastructure error)." },
          },
          publish: { onDone: { kind: "done", message: "✓ Pushed the fixes and replied on the PR. Merging stays a human call." } },
        },
      }),
  },
  {
    id: "dependency-scan",
    label: "Dependency sitter",
    description: "Sit on vulnerable deps — verified patch/minor bumps as draft PRs.",
    manifest: () =>
      LoopManifestSchema.parse({
        kind: "my-dep-loop",
        version: 1,
        description: "Sits on vulnerable or outdated dependencies: confirms the advisory, applies the safe bump, verifies, and opens a draft PR. Never merges.",
        workSource: { type: "dependency-scan" },
        maxIterations: 2,
        stages: [
          { name: "scan", kind: "check", command: "scan", agent: "loop-scan", prompt: "stages/scan.md", isolation: "none" },
          { name: "upgrade", kind: "work", command: "upgrade", agent: "loop-upgrade", prompt: "stages/upgrade.md" },
          { name: "verify", kind: "check", command: "verify", agent: "loop-verify", prompt: "stages/verify.md" },
          { name: "publish", kind: "work", command: "publish", agent: "loop-publish", prompt: "stages/publish.md" },
        ],
        transitions: {
          scan: {
            onPass: { kind: "fire", stage: "upgrade" },
            onFail: { kind: "done", message: "✓ The upgrade is already resolved or no longer applies." },
            onError: { kind: "stop", message: "✗ Scan could not read the dependency reports — fix the environment and let the next poll retry." },
          },
          upgrade: { onDone: { kind: "fire", stage: "verify" } },
          verify: {
            onPass: { kind: "fire", stage: "publish" },
            onFail: {
              kind: "fire",
              stage: "upgrade",
              countIteration: true,
              capMessage: "✗ Verify failed after {maxIterations} iterations. The upgrade parks until its target version moves.",
            },
            onError: { kind: "stop", message: "✗ Verify could not run (environment/infrastructure error)." },
          },
          publish: { onDone: { kind: "done", message: "✓ Pushed the upgrade and opened a draft PR. Merging stays a human call." } },
        },
      }),
  },
  {
    id: "ci-runs",
    label: "CI sitter",
    description: "Sit on the watched branch's CI — verified remedy PRs when it goes red.",
    manifest: () =>
      LoopManifestSchema.parse({
        kind: "my-ci-loop",
        version: 1,
        description: "Sits on the watched branch's CI: diagnoses red runs, builds a verified remedy, and opens a draft PR. Never pushes the watched branch.",
        workSource: { type: "ci-runs", workflows: [] },
        maxIterations: 2,
        stages: [
          { name: "diagnose", kind: "check", command: "diagnose", agent: "loop-diagnose", prompt: "stages/diagnose.md" },
          { name: "remedy", kind: "work", command: "remedy", agent: "loop-remedy", prompt: "stages/remedy.md" },
          { name: "verify", kind: "check", command: "verify", agent: "loop-verify", prompt: "stages/verify.md" },
          { name: "publish", kind: "work", command: "publish", agent: "loop-publish", prompt: "stages/publish.md" },
        ],
        transitions: {
          diagnose: {
            onPass: { kind: "fire", stage: "remedy" },
            onFail: { kind: "done", message: "✓ The failure is a flake or the branch already recovered." },
            onError: { kind: "stop", message: "✗ Diagnose could not inspect the failure — fix the environment and let the next poll retry." },
          },
          remedy: { onDone: { kind: "fire", stage: "verify" } },
          verify: {
            onPass: { kind: "fire", stage: "publish" },
            onFail: {
              kind: "fire",
              stage: "remedy",
              countIteration: true,
              capMessage: "✗ Verify failed after {maxIterations} iterations; prefer the revert path.",
            },
            onError: { kind: "stop", message: "✗ Verify could not run (environment/infrastructure error)." },
          },
          publish: {
            onDone: { kind: "done", message: "✓ Pushed the remedy and opened a draft PR. The watched branch was never touched; merging stays a human call." },
          },
        },
      }),
  },
]
