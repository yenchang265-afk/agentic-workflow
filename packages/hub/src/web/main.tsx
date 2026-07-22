import { StrictMode, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import type { MonitorKindsResponse } from "../shared/api.js"
import { ConfigEditor } from "./config/ConfigEditor.js"
import { Creator } from "./creator/Creator.js"
import { EventsProvider, useEvents } from "./events.js"
import { ActivePanel } from "./monitor/ActivePanel.js"
import { Board } from "./monitor/Board.js"
import { PrKindPanel } from "./monitor/PrKindPanel.js"
import { Runs } from "./monitor/Runs.js"
import { RepoPicker, RepoProvider, repoPath, useRepo } from "./repo.js"
import { useJson } from "./useJson.js"
import { Button } from "./ui/Button.js"
import { BellIcon } from "./ui/icons.js"
import { ThemeToggle } from "./ui/ThemeToggle.js"
import "./theme.css"

type Tab = "monitor" | "creator" | "config"

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "monitor", label: "Workflow monitor" },
  { id: "creator", label: "Workflow creator" },
  { id: "config", label: "Config" },
]

const HeaderStatus = () => {
  const { connected, notifications, requestNotifications } = useEvents()
  return (
    <div className="header-status">
      <span className={`live-dot${connected ? " on" : ""}`} title={connected ? "live updates on" : "reconnecting…"} />
      {notifications !== "unsupported" && notifications !== "granted" && (
        <Button
          variant="ghost"
          icon
          title="Notify me when a task parks at a gate"
          aria-label="Enable gate notifications"
          onClick={requestNotifications}
        >
          <BellIcon />
        </Button>
      )}
      <ThemeToggle />
    </div>
  )
}

/**
 * The monitor, one sub-tab per enabled workflow kind (from the repo's config +
 * manifests): backlog kinds render the board, PR-shaped kinds the ledger
 * panel. Selection persists per repo in localStorage.
 */
const Monitor = () => {
  const { repoId } = useRepo()
  const storageKey = `hub.kind.${repoId ?? ""}`
  const [kind, setKind] = useState<string | null>(null)
  // Restore the per-repo kind when the repo resolves or the user switches — the
  // mount-time `repoId` is null, so reading localStorage in the initializer would
  // always miss the real per-repo key (and never re-read on a repo switch).
  useEffect(() => setKind(localStorage.getItem(storageKey)), [storageKey])

  const { data, error } = useJson<MonitorKindsResponse>(repoPath("/api/monitor/kinds", repoId), [repoId])
  const kinds = data?.kinds ?? (error ? [] : null)

  if (!kinds) return <div className="placeholder">Loading kinds…</div>
  const active = kinds.find((k) => k.kind === kind) ?? kinds[0]
  return (
    <div>
      <ActivePanel />
      {kinds.length > 1 && (
        <nav className="kind-tabs">
          {kinds.map((k) => (
            <button
              key={k.kind}
              className={`kind-tab${active?.kind === k.kind ? " active" : ""}`}
              title={k.description}
              onClick={() => {
                setKind(k.kind)
                localStorage.setItem(storageKey, k.kind)
              }}
            >
              {k.kind}
            </button>
          ))}
        </nav>
      )}
      {!active && <div className="placeholder">No enabled workflow kinds — check .agentic-workflow.json and the workflows dir.</div>}
      {active && (active.sourceType === "backlog" ? <Board info={active} /> : <PrKindPanel info={active} />)}
      <h2 className="section-title">Run history</h2>
      <Runs />
    </div>
  )
}

const App = () => {
  const [tab, setTab] = useState<Tab>("monitor")
  return (
    <div className="hub">
      <header className="hub-header">
        <h1>
          agentic-workflow hub <span className="beta-badge">beta</span>
        </h1>
        <nav className="hub-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`hub-tab${tab === t.id ? " active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <RepoPicker />
        <HeaderStatus />
      </header>
      <main className="hub-main">
        {tab === "monitor" && <Monitor />}
        {tab === "creator" && <Creator />}
        {tab === "config" && <ConfigEditor />}
      </main>
    </div>
  )
}

const root = document.getElementById("root")
if (root)
  createRoot(root).render(
    <StrictMode>
      <EventsProvider>
        <RepoProvider>
          <App />
        </RepoProvider>
      </EventsProvider>
    </StrictMode>,
  )
