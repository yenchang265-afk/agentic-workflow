import type { Effect, LoopManifest, StageDef, Transition } from "@agentic-loop/core/manifest/schema"

/**
 * The creator's graph model — pure, no React Flow imports (the component
 * layer adapts it). Stages are nodes; each transition slot is one edge whose
 * data is the full manifest `Effect`, so `graphToManifest` is an exact
 * inverse of `manifestToGraph`. park/done/stop effects point at synthesized
 * terminal nodes deduped by outcome+status (the effect's message rides on the
 * edge, not the terminal, so two stages sharing a terminal keep their own
 * messages).
 */

export type TransitionSlot = "onDone" | "onPass" | "onFail" | "onError"

export interface StageNode {
  readonly id: string
  readonly type: "stage"
  readonly stage: StageDef
}

export interface TerminalNode {
  readonly id: string
  readonly type: "terminal"
  readonly outcome: "park" | "done" | "stop"
  readonly toStatus?: string
}

export type GraphNode = StageNode | TerminalNode

export interface GraphEdge {
  readonly id: string
  /** Source stage name. */
  readonly from: string
  readonly slot: TransitionSlot
  /** Target node id — a stage name or a terminal key. */
  readonly to: string
  readonly effect: Effect
}

/** Everything that lives on the manifest but not in the graph shape. */
export interface GraphMeta {
  readonly kind: string
  readonly version: LoopManifest["version"]
  readonly description: string
  readonly workSource: LoopManifest["workSource"]
  readonly maxIterations?: number
  readonly hooks: LoopManifest["hooks"]
}

export interface LoopGraph {
  readonly nodes: readonly GraphNode[]
  readonly edges: readonly GraphEdge[]
  readonly meta: GraphMeta
}

export const SLOTS: readonly TransitionSlot[] = ["onDone", "onPass", "onFail", "onError"]

/** Terminal node id for a non-fire effect. Pure. */
export const terminalId = (effect: Effect): string =>
  effect.kind === "stop" ? "terminal:stop" : `terminal:${effect.kind}:${("toStatus" in effect ? effect.toStatus : undefined) ?? ""}`

/** What the add-terminal UI proposes; the shape terminal nodes dedupe on. */
export interface TerminalSpec {
  readonly outcome: "park" | "done" | "stop"
  readonly toStatus?: string
}

/** Same dedup key `terminalId` uses: outcome + status, with stop ignoring status. Pure. */
export const sameTerminalSpec = (a: TerminalSpec, b: TerminalSpec): boolean =>
  a.outcome === b.outcome && (a.outcome === "stop" || (a.toStatus ?? "") === (b.toStatus ?? ""))

/** Status choices for the terminal picker: backlog exposes its lifecycle statuses, other sources have none. Pure. */
export const terminalStatusOptions = (ws: LoopManifest["workSource"]): readonly string[] =>
  ws.type === "backlog" ? ws.statuses : []

const effectTarget = (effect: Effect): string => (effect.kind === "fire" ? effect.stage : terminalId(effect))

export const manifestToGraph = (manifest: LoopManifest): LoopGraph => {
  const nodes: GraphNode[] = manifest.stages.map((stage) => ({ id: stage.name, type: "stage", stage }))
  const edges: GraphEdge[] = []
  const terminals = new Map<string, TerminalNode>()

  for (const stage of manifest.stages) {
    const transition = manifest.transitions[stage.name] ?? {}
    for (const slot of SLOTS) {
      const effect = (transition as Record<TransitionSlot, Effect | undefined>)[slot]
      if (!effect) continue
      if (effect.kind !== "fire") {
        const id = terminalId(effect)
        if (!terminals.has(id)) {
          terminals.set(id, {
            id,
            type: "terminal",
            outcome: effect.kind,
            ...("toStatus" in effect && effect.toStatus ? { toStatus: effect.toStatus } : {}),
          })
        }
      }
      edges.push({ id: `${stage.name}:${slot}`, from: stage.name, slot, to: effectTarget(effect), effect })
    }
  }

  return {
    nodes: [...nodes, ...terminals.values()],
    edges,
    meta: {
      kind: manifest.kind,
      version: manifest.version,
      description: manifest.description,
      workSource: manifest.workSource,
      ...(manifest.maxIterations !== undefined ? { maxIterations: manifest.maxIterations } : {}),
      hooks: manifest.hooks,
    },
  }
}

export const graphToManifest = (graph: LoopGraph): LoopManifest => {
  const stages = graph.nodes.flatMap((n) => (n.type === "stage" ? [n.stage] : []))
  const transitions: Record<string, Transition> = {}
  for (const stage of stages) transitions[stage.name] = {}
  for (const edge of graph.edges) {
    const t = (transitions[edge.from] ??= {})
    ;(t as Record<TransitionSlot, Effect>)[edge.slot] = edge.effect
  }
  return {
    kind: graph.meta.kind,
    version: graph.meta.version,
    description: graph.meta.description,
    workSource: graph.meta.workSource,
    stages,
    transitions,
    ...(graph.meta.maxIterations !== undefined ? { maxIterations: graph.meta.maxIterations } : {}),
    hooks: graph.meta.hooks,
  }
}
