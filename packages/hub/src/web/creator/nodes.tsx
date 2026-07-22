import { Handle, Position, type NodeProps } from "@xyflow/react"
import type { StageDef } from "@agentic-workflow/core/manifest/schema"

/** Custom React Flow nodes: work stages (single onDone output), check stages
 *  (pass/fail/error outputs), and terminal pills (park/done/stop). */

export interface StageNodeData {
  readonly stage: StageDef
  readonly invalid?: boolean
  [key: string]: unknown
}

export interface TerminalNodeData {
  readonly outcome: "park" | "done" | "stop"
  readonly toStatus?: string
  [key: string]: unknown
}

const CHECK_SLOTS = [
  { id: "onPass", label: "pass" },
  { id: "onFail", label: "fail" },
  { id: "onError", label: "error" },
] as const

export const StageFlowNode = ({ data, selected }: NodeProps) => {
  const { stage, invalid } = data as StageNodeData
  const isCheck = stage.kind === "check"
  return (
    <div className={`flow-stage${isCheck ? " check" : ""}${selected ? " selected" : ""}${invalid ? " invalid" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <div className="flow-stage-name">{stage.name}</div>
      <div className="flow-stage-meta">
        {stage.kind} · {stage.agent}
        {stage.model ? ` · ${stage.model}` : ""}
      </div>
      <div className="flow-stage-meta muted">{stage.isolation === "none" ? "main tree" : "worktree"}</div>
      {isCheck ? (
        CHECK_SLOTS.map((slot, i) => (
          <Handle
            key={slot.id}
            id={slot.id}
            type="source"
            position={Position.Right}
            style={{ top: `${25 + i * 25}%` }}
            className={`handle-${slot.label}`}
            title={slot.label}
          />
        ))
      ) : (
        <Handle id="onDone" type="source" position={Position.Right} title="done" />
      )}
    </div>
  )
}

export const TerminalFlowNode = ({ data, selected }: NodeProps) => {
  const { outcome, toStatus } = data as TerminalNodeData
  return (
    <div className={`flow-terminal ${outcome}${selected ? " selected" : ""}`}>
      <Handle type="target" position={Position.Left} />
      {outcome}
      {toStatus ? ` → ${toStatus}/` : ""}
    </div>
  )
}

export const nodeTypes = { stage: StageFlowNode, terminal: TerminalFlowNode }
