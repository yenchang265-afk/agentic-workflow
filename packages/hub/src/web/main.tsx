import { StrictMode, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import type { KindBoardInfo, MonitorKindsResponse } from "../shared/api.js"
import { fetchJson } from "./api.js"
import { Creator } from "./creator/Creator.js"
import { EventsProvider, useEvents } from "./events.js"
import { ActivePanel } from "./monitor/ActivePanel.js"
import { Board } from "./monitor/Board.js"
import { PrKindPanel } from "./monitor/PrKindPanel.js"
import { Runs } from "./monitor/Runs.js"
import { RepoPicker, RepoProvider, repoPath, useRepo } from "./repo.js"
import { Button } from "./ui/Button.js"
import { BellIcon } from "./ui/icons.js"
import { ThemeToggle } from "./ui/ThemeToggle.js"
import "./theme.css"

type Tab = "monitor" | "creator"

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "monitor", label: "Loop monitor" },
  { id: "creator", label: "Loop creator" },
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
 * The monitor, one sub-tab per enabled loop kind (from the repo's config +
 * manifests): backlog kinds render the board, PR-shaped kinds the ledger
 * panel. Selection persists per repo in localStorage.
 */
const Monitor = () => {
  const [kinds, setKinds] = useState<readonly KindBoardInfo[] | null>(null)
  const { repoId } = useRepo()
  const storageKey = `hub.kind.${repoId ?? ""}`
  const [kind, setKind] = useState<string | null>(() => localStorage.getItem(storageKey))

  useEffect(() => {
    fetchJson<MonitorKindsResponse>(repoPath("/api/monitor/kinds", repoId))
      .then((d) => setKinds(d.kinds))
      .catch(() => setKinds([]))
  }, [repoId])

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
      {!active && <div className="placeholder">No enabled loop kinds — check .agentic-loop.json and the loops dir.</div>}
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
          agentic-loop hub <span className="beta-badge">beta</span>
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
