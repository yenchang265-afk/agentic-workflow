import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { LoopManifestSchema, type Effect, type LoopManifest, type StageDef } from "@agentic-loop/core/manifest/schema"
import type { ChecklistItem, KindDetailResponse, KindsResponse, ManifestIssue, SaveKindResponse } from "../../shared/api.js"
import { fetchJson, postJson } from "../api.js"
import { EdgeForm, MetaForm, StageForm, type EdgeFormValue } from "./forms.js"
import { manifestToGraph, type GraphMeta, type TransitionSlot } from "./graphmodel.js"
import { layoutGraph } from "./layout.js"
import { Button } from "../ui/Button.js"
import { CheckIcon, CircleIcon } from "../ui/icons.js"
import { nodeTypes, type StageNodeData, type TerminalNodeData } from "./nodes.js"

/**
 * The visual loop creator: React Flow canvas over the pure graph model.
 * Node/edge data is the single source of truth; validate/save rebuild the
 * manifest from it. The same zod schema that gates the engine is bundled here
 * for instant feedback — the server runs it again on save.
 */

interface EdgeData extends EdgeFormValue {
  [key: string]: unknown
}

const slotOf = (edge: Edge): TransitionSlot => (edge.sourceHandle as TransitionSlot | undefined) ?? "onDone"

const edgeLabel = (slot: TransitionSlot, data: EdgeFormValue): string => {
  const verb = slot.replace(/^on/, "").toLowerCase()
  return data.countIteration ? `${verb} (counted)` : verb
}

const NEW_MANIFEST: LoopManifest = LoopManifestSchema.parse({
  kind: "my-loop",
  version: 1,
  description: "Describe what this loop drives.",
  workSource: { type: "backlog", statuses: ["queued", "in-progress", "completed"], pools: [{ status: "queued", entryStage: "work" }] },
  stages: [
    { name: "work", kind: "work", command: "work", agent: "loop-work", prompt: "stages/work.md" },
    { name: "verify", kind: "check", command: "verify-work", agent: "loop-verify-work", prompt: "stages/verify.md" },
  ],
  transitions: {
    work: { onDone: { kind: "fire", stage: "verify" } },
    verify: {
      onPass: { kind: "done", message: "Work verified." },
      onFail: { kind: "fire", stage: "work", countIteration: true, capMessage: "Gave up after {maxIterations} iterations." },
      onError: { kind: "stop", message: "Verification errored — investigate manually." },
    },
  },
})

const toFlow = (manifest: LoopManifest): { nodes: Node[]; edges: Edge[]; meta: GraphMeta } => {
  const graph = manifestToGraph(manifest)
  const pos = layoutGraph(graph)
  const nodes: Node[] = graph.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: pos[n.id] ?? { x: 0, y: 0 },
    data:
      n.type === "stage"
        ? ({ stage: n.stage } satisfies StageNodeData)
        : ({ outcome: n.outcome, ...(n.toStatus ? { toStatus: n.toStatus } : {}) } satisfies TerminalNodeData),
  }))
  const edges: Edge[] = graph.edges.map((e) => {
    const data: EdgeData = {
      targetIsTerminal: e.effect.kind !== "fire",
      ...("message" in e.effect ? { message: e.effect.message } : {}),
      ...(e.effect.kind === "fire" && e.effect.countIteration ? { countIteration: true } : {}),
      ...(e.effect.kind === "fire" && e.effect.capMessage ? { capMessage: e.effect.capMessage } : {}),
      ...(e.effect.kind === "fire" && e.effect.dropArtifacts ? { dropArtifacts: e.effect.dropArtifacts } : {}),
    }
    return { id: e.id, source: e.from, target: e.to, sourceHandle: e.slot, data, label: edgeLabel(e.slot, data) }
  })
  return { nodes, edges, meta: manifestToGraph(manifest).meta }
}

const fromFlow = (nodes: readonly Node[], edges: readonly Edge[], meta: GraphMeta): LoopManifest => {
  const stageOf = new Map(nodes.filter((n) => n.type === "stage").map((n) => [n.id, (n.data as StageNodeData).stage]))
  const terminalOf = new Map(
    nodes.filter((n) => n.type === "terminal").map((n) => [n.id, n.data as TerminalNodeData]),
  )
  const stages = [...stageOf.values()]
  const transitions: Record<string, Partial<Record<TransitionSlot, Effect>>> = {}
  for (const stage of stages) transitions[stage.name] = {}
  for (const edge of edges) {
    const from = stageOf.get(edge.source)
    if (!from) continue
    const data = (edge.data ?? {}) as EdgeData
    const targetStage = stageOf.get(edge.target)
    const terminal = terminalOf.get(edge.target)
    let effect: Effect
    if (targetStage) {
      // zod materializes fire's defaults on parse, so mirror them here for exact round-trips
      effect = {
        kind: "fire",
        stage: targetStage.name,
        countIteration: data.countIteration ?? false,
        dropArtifacts: [...(data.dropArtifacts ?? [])],
        ...(data.capMessage ? { capMessage: data.capMessage } : {}),
      }
    } else if (terminal) {
      effect =
        terminal.outcome === "stop"
          ? { kind: "stop", message: data.message ?? "" }
          : {
              kind: terminal.outcome,
              ...(terminal.toStatus ? { toStatus: terminal.toStatus } : {}),
              message: data.message ?? "",
            }
    } else {
      continue
    }
    ;(transitions[from.name] ??= {})[slotOf(edge)] = effect
  }
  return {
    kind: meta.kind,
    version: meta.version,
    description: meta.description,
    workSource: meta.workSource,
    stages,
    transitions: transitions as LoopManifest["transitions"],
    ...(meta.maxIterations !== undefined ? { maxIterations: meta.maxIterations } : {}),
    hooks: meta.hooks,
  }
}

export const Creator = () => {
  const [kinds, setKinds] = useState<string[]>([])
  const [loadedKind, setLoadedKind] = useState<string | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [meta, setMeta] = useState<GraphMeta | null>(null)
  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [prompts, setPrompts] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<{ kind: "node" | "edge"; id: string } | null>(null)
  const [issues, setIssues] = useState<ManifestIssue[] | null>(null)
  const [saved, setSaved] = useState<SaveKindResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchJson<KindsResponse>("/api/kinds")
      .then((r) => setKinds(r.kinds.map((k) => k.kind)))
      .catch((e: Error) => setError(e.message))
  }, [])

  const load = (manifest: LoopManifest, promptsIn: Record<string, string>, fresh: boolean): void => {
    const flow = toFlow(manifest)
    setMeta(flow.meta)
    setNodes(flow.nodes)
    setEdges(flow.edges)
    setPrompts(promptsIn)
    setIsNew(fresh)
    setSelected(null)
    setIssues(null)
    setSaved(null)
  }

  // Bumped on every open so a slow response for a kind the user has since
  // navigated away from is dropped instead of clobbering the current one.
  const openSeq = useRef(0)
  const openKind = (kind: string): void => {
    const seq = ++openSeq.current
    setLoadedKind(kind)
    setError(null) // clear any prior open/save error before the new load
    fetchJson<KindDetailResponse>(`/api/kinds/${encodeURIComponent(kind)}`)
      .then((r) => {
        if (seq === openSeq.current) load(r.manifest, { ...r.prompts }, false)
      })
      .catch((e: Error) => {
        if (seq === openSeq.current) setError(e.message)
      })
  }

  const currentManifest = useMemo(
    () => (meta ? fromFlow(nodes, edges, meta) : null),
    [nodes, edges, meta],
  )

  // instant client-side validation with the same schema the engine uses
  const liveIssues = useMemo<ManifestIssue[]>(() => {
    if (!currentManifest) return []
    const result = LoopManifestSchema.safeParse(currentManifest)
    return result.success ? [] : result.error.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message }))
  }, [currentManifest])

  const onNodesChange = useCallback((changes: NodeChange[]) => setNodes((ns) => applyNodeChanges(changes, ns)), [])
  const onEdgesChange = useCallback((changes: EdgeChange[]) => setEdges((es) => applyEdgeChanges(changes, es)), [])

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return
      setEdges((es) => {
        const slot = (conn.sourceHandle as TransitionSlot | null) ?? "onDone"
        const target = nodes.find((n) => n.id === conn.target)
        const data: EdgeData = { targetIsTerminal: target?.type === "terminal", ...(target?.type === "terminal" ? { message: "" } : {}) }
        const next: Edge = {
          id: `${conn.source}:${slot}:${conn.target}`,
          source: conn.source,
          target: conn.target,
          sourceHandle: slot,
          data,
          label: edgeLabel(slot, data),
        }
        // one effect per slot — a new connection replaces the slot's edge
        return [...es.filter((e) => !(e.source === conn.source && slotOf(e) === slot)), next]
      })
    },
    [nodes],
  )

  const addStage = (): void => {
    const name = `stage-${nodes.filter((n) => n.type === "stage").length + 1}`
    const stage: StageDef = {
      name,
      kind: "work",
      command: name,
      agent: `loop-${name}`,
      prompt: `stages/${name}.md`,
      isolation: "worktree",
      bashAllowlist: [],
      platformAllowlist: {},
    }
    setNodes((ns) => [...ns, { id: `node-${Date.now()}`, type: "stage", position: { x: 40, y: 40 }, data: { stage } }])
  }

  const addTerminal = (outcome: "park" | "done" | "stop"): void => {
    const toStatus = outcome === "stop" ? undefined : window.prompt(`${outcome}: target status folder (blank = none)`) || undefined
    setNodes((ns) => [
      ...ns,
      {
        id: `terminal-${outcome}-${Date.now()}`,
        type: "terminal",
        position: { x: 120, y: 260 },
        data: { outcome, ...(toStatus ? { toStatus } : {}) },
      },
    ])
  }

  const updateStage = (nodeId: string, stage: StageDef): void =>
    setNodes((ns) => ns.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, stage } } : n)))

  const deleteNode = (nodeId: string): void => {
    setNodes((ns) => ns.filter((n) => n.id !== nodeId))
    setEdges((es) => es.filter((e) => e.source !== nodeId && e.target !== nodeId))
    setSelected(null)
  }

  const updateEdge = (edgeId: string, data: EdgeFormValue): void =>
    setEdges((es) =>
      es.map((e) => (e.id === edgeId ? { ...e, data: data as EdgeData, label: edgeLabel(slotOf(e), data) } : e)),
    )

  const validateOnServer = async (): Promise<void> => {
    if (!currentManifest) return
    try {
      const res = await postJson<{ valid: boolean; issues: ManifestIssue[] }>("/api/kinds/validate", {
        manifest: currentManifest,
      })
      setIssues(res.issues)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const save = async (): Promise<void> => {
    if (!currentManifest) return
    try {
      const res = await postJson<SaveKindResponse>(`/api/kinds/${encodeURIComponent(currentManifest.kind)}`, {
        manifest: currentManifest,
        prompts,
        overwrite: !isNew && loadedKind === currentManifest.kind,
      })
      setSaved(res)
      setError(null)
      if (!kinds.includes(currentManifest.kind)) setKinds((k) => [...k, currentManifest.kind])
      setIsNew(false)
      setLoadedKind(currentManifest.kind)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const selectedNode = selected?.kind === "node" ? nodes.find((n) => n.id === selected.id) : undefined
  const selectedEdge = selected?.kind === "edge" ? edges.find((e) => e.id === selected.id) : undefined
  const targetLabelOf = (edge: Edge): string => {
    const t = nodes.find((n) => n.id === edge.target)
    if (!t) return edge.target
    return t.type === "stage" ? (t.data as StageNodeData).stage.name : `${(t.data as TerminalNodeData).outcome}`
  }

  if (!meta) {
    return (
      <div>
        {error && <div className="error-banner">{error}</div>}
        <div className="creator-start">
          <h2 className="section-title">Open a loop kind</h2>
          <div className="summary-chips">
            {kinds.map((k) => (
              <Button key={k} onClick={() => openKind(k)}>
                {k}
              </Button>
            ))}
            <Button onClick={() => load(NEW_MANIFEST, {}, true)}>+ new kind</Button>
          </div>
          <p className="muted">
            A loop kind is a declarative state machine: stages (work/check nodes) wired by transitions
            (fire/park/done/stop edges) over a work source. Open a shipped kind to see the shape, or start a new one.
          </p>
        </div>
      </div>
    )
  }

  const allIssues = issues ?? liveIssues

  return (
    <div className="creator">
      {error && <div className="error-banner">{error}</div>}
      <div className="creator-toolbar">
        <Button onClick={() => setMeta(null)}>← kinds</Button>
        <Button onClick={addStage}>+ stage</Button>
        <Button onClick={() => addTerminal("park")}>+ park</Button>
        <Button onClick={() => addTerminal("done")}>+ done</Button>
        <Button onClick={() => addTerminal("stop")}>+ stop</Button>
        <span className="spacer" />
        <span className={`badge ${allIssues.length ? "gate" : "ok"}`}>
          {allIssues.length ? `${allIssues.length} issue${allIssues.length > 1 ? "s" : ""}` : "valid"}
        </span>
        <Button onClick={() => void validateOnServer()}>Validate</Button>
        <Button variant="primary" disabled={allIssues.length > 0} onClick={() => void save()}>
          Save
        </Button>
      </div>
      <div className="creator-body">
        <div className="creator-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelected({ kind: "node", id: n.id })}
            onEdgeClick={(_, e) => setSelected({ kind: "edge", id: e.id })}
            onPaneClick={() => setSelected(null)}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--grid)" />
            <Controls />
          </ReactFlow>
        </div>
        <div className="creator-panel">
          {selectedNode?.type === "stage" ? (
            <StageForm
              stage={(selectedNode.data as StageNodeData).stage}
              prompt={prompts[(selectedNode.data as StageNodeData).stage.name] ?? ""}
              onChange={(next) => {
                const prev = (selectedNode.data as StageNodeData).stage.name
                if (prev !== next.name && prompts[prev] !== undefined) {
                  setPrompts(({ [prev]: moved, ...rest }) => ({ ...rest, [next.name]: moved ?? "" }))
                }
                updateStage(selectedNode.id, next)
              }}
              onPromptChange={(text) =>
                setPrompts((p) => ({ ...p, [(selectedNode.data as StageNodeData).stage.name]: text }))
              }
              onDelete={() => deleteNode(selectedNode.id)}
            />
          ) : selectedNode?.type === "terminal" ? (
            <div className="panel-form">
              <h3>Terminal: {(selectedNode.data as TerminalNodeData).outcome}</h3>
              <p className="muted">
                {(selectedNode.data as TerminalNodeData).toStatus
                  ? `Moves the task to ${(selectedNode.data as TerminalNodeData).toStatus}/.`
                  : "No status move."}{" "}
                Messages live on the incoming edges.
              </p>
              <Button variant="danger" onClick={() => deleteNode(selectedNode.id)}>
                Delete terminal
              </Button>
            </div>
          ) : selectedEdge ? (
            <EdgeForm
              slot={slotOf(selectedEdge)}
              targetLabel={targetLabelOf(selectedEdge)}
              value={(selectedEdge.data ?? { targetIsTerminal: false }) as unknown as EdgeFormValue}
              onChange={(next) => updateEdge(selectedEdge.id, next)}
              onDelete={() => {
                setEdges((es) => es.filter((e) => e.id !== selectedEdge.id))
                setSelected(null)
              }}
            />
          ) : (
            <MetaForm meta={meta} onChange={setMeta} />
          )}
          {allIssues.length > 0 && (
            <div className="issues">
              <h3>Validation</h3>
              {allIssues.map((i, k) => (
                <div key={k} className="issue">
                  <code>{i.path}</code> {i.message}
                </div>
              ))}
            </div>
          )}
          {saved && (
            <div className="checklist">
              <h3>Saved — remaining steps</h3>
              <div className="muted">wrote: {saved.written.join(", ")}</div>
              {saved.checklist.map((c: ChecklistItem, k: number) => (
                <div key={k} className={`check-item${c.done ? " done" : ""}`}>
                  {c.done ? <CheckIcon /> : <CircleIcon />} {c.label}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
