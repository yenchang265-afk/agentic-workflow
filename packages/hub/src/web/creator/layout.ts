import type { WorkflowGraph } from "./graphmodel.js"

/**
 * Hand-rolled layered layout — these graphs are ≤10 nodes, dagre/elk would be
 * a dependency for nothing. Rank = BFS depth from the entry stages (fire
 * edges only), terminals one rank past their deepest source; nodes stack
 * vertically within a rank. Pure.
 */

export interface Position {
  readonly x: number
  readonly y: number
}

const COL_W = 280
const ROW_H = 140

export const layoutGraph = (graph: WorkflowGraph): Readonly<Record<string, Position>> => {
  const stageIds = graph.nodes.filter((n) => n.type === "stage").map((n) => n.id)
  const rank = new Map<string, number>()

  // entries: stages nothing fires into
  const firedInto = new Set(graph.edges.filter((e) => e.effect.kind === "fire").map((e) => e.to))
  const entries = stageIds.filter((id) => !firedInto.has(id))
  const queue: string[] = (entries.length ? entries : stageIds.slice(0, 1)).map((id) => {
    rank.set(id, 0)
    return id
  })

  while (queue.length) {
    const id = queue.shift() as string
    const r = rank.get(id) ?? 0
    for (const edge of graph.edges) {
      if (edge.from !== id || edge.effect.kind !== "fire") continue
      if (!rank.has(edge.to)) {
        rank.set(edge.to, r + 1)
        queue.push(edge.to)
      }
    }
  }
  // disconnected stages after the ranked ones
  let maxRank = 0
  for (const r of rank.values()) maxRank = Math.max(maxRank, r)
  for (const id of stageIds) if (!rank.has(id)) rank.set(id, ++maxRank)

  // terminals: one past their deepest source
  for (const node of graph.nodes) {
    if (node.type !== "terminal") continue
    const sources = graph.edges.filter((e) => e.to === node.id).map((e) => rank.get(e.from) ?? 0)
    rank.set(node.id, (sources.length ? Math.max(...sources) : maxRank) + 1)
  }

  const byRank = new Map<number, string[]>()
  for (const node of graph.nodes) {
    const r = rank.get(node.id) ?? 0
    byRank.set(r, [...(byRank.get(r) ?? []), node.id])
  }

  const positions: Record<string, Position> = {}
  for (const [r, ids] of byRank) {
    ids.forEach((id, i) => {
      positions[id] = { x: r * COL_W, y: i * ROW_H }
    })
  }
  return positions
}
