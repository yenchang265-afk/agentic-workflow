import { StrictMode, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import type { MonitorKindsResponse } from "../shared/api.js"
import { ActivityLog } from "./ActivityLog.js"
import { ConfigEditor } from "./config/ConfigEditor.js"
import { Creator } from "./creator/Creator.js"
import { EventsProvider, useEvents } from "./events.js"
import { FeedbackProvider } from "./feedback.js"
import { MetricsTab } from "./metrics/MetricsTab.js"
import { ActivePanel } from "./monitor/ActivePanel.js"
import { Board } from "./monitor/Board.js"
import { PrKindPanel } from "./monitor/PrKindPanel.js"
import { SchedulerPanel } from "./monitor/SchedulerPanel.js"
import { Runs } from "./monitor/Runs.js"
import { RepoPicker, RepoProvider, repoPath, useRepo } from "./repo.js"
import { ReviewQueue } from "./review/ReviewQueue.js"
import { useResource } from "./resource.js"
import { buildHash, type Screen } from "./route.js"
import { Link, useRoute } from "./routing.js"
import { Button } from "./ui/Button.js"
import { BellIcon } from "./ui/icons.js"
import { ThemeToggle } from "./ui/ThemeToggle.js"
import "./theme.css"

const TABS: readonly { id: Screen; label: string }[] = [
  { id: "review", label: "Review queue" },
  { id: "monitor", label: "Workflow monitor" },
  { id: "creator", label: "Workflow creator" },
  { id: "metrics", label: "Metrics" },
  { id: "config", label: "Config" },
]

const HeaderStatus = () => {
  const { connected, notifications, requestNotifications } = useEvents()
  return (
    <div className="header-status">
      <span
        className={`live-dot${connected ? " on" : ""}`}
        title={connected ? "live updates on" : "reconnecting…"}
        role="status"
        aria-live="polite"
        aria-label={connected ? "live updates on" : "reconnecting"}
      />
      <ActivityLog />
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
 * manifests): backlog kinds render the board, PR-shaped kinds the ledger panel.
 *
 * The kind lives in the URL (`#/monitor/engineering`) so a board is linkable,
 * and falls back to the per-repo localStorage key so a bare `#/monitor` still
 * lands where you left off.
 */
const Monitor = () => {
  const { repoId } = useRepo()
  const route = useRoute()
  const storageKey = `hub.kind.${repoId ?? ""}`
  const [remembered, setRemembered] = useState<string | null>(null)
  // Read the per-repo key when the repo resolves or the user switches — the
  // mount-time `repoId` is null, so reading localStorage in the initializer would
  // always miss the real per-repo key (and never re-read on a repo switch).
  useEffect(() => setRemembered(localStorage.getItem(storageKey)), [storageKey])
  const kind = route.params[0] ?? remembered

  const { data, error, refetch } = useResource<MonitorKindsResponse>(repoPath("/api/monitor/kinds", repoId), [repoId])

  const kinds = data?.kinds
  const active = kinds?.find((k) => k.kind === kind) ?? kinds?.[0]

  // Remember whichever kind actually resolved, so a bare `#/monitor` (a
  // bookmark, the header tab) returns to it. Above the early returns because
  // hooks cannot live after a conditional return.
  const activeKind = active?.kind
  useEffect(() => {
    if (repoId !== null && activeKind !== undefined) localStorage.setItem(storageKey, activeKind)
  }, [repoId, storageKey, activeKind])

  // Three states, not two. Folding the error case into an empty list rendered a
  // dead server or a failed fetch as "No enabled workflow kinds — check
  // .agentic-workflow.json", sending the user to edit a file that was never the
  // problem. An unreachable server and a repo with no kinds enabled are
  // different findings and say so.
  if (error)
    return (
      <div className="error-banner">
        Could not load workflow kinds: {error} <Button onClick={refetch}>Retry</Button>
      </div>
    )
  if (!kinds) return <div className="placeholder">Loading kinds…</div>
  return (
    <div>
      <ActivePanel />
      <SchedulerPanel />
      {kinds.length > 1 && (
        <nav className="kind-tabs" aria-label="Workflow kinds">
          {kinds.map((k) => (
            <Link
              key={k.kind}
              to={buildHash({ screen: "monitor", params: [k.kind], query: route.query })}
              className={`kind-tab${active?.kind === k.kind ? " active" : ""}`}
              title={k.description}
              ariaCurrent={active?.kind === k.kind}
            >
              {k.kind}
            </Link>
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
  const route = useRoute()
  // Carry the repo across a section switch — changing tab shouldn't change
  // which repo you are looking at — but not the previous section's params or
  // its `run`/`task` selections, which mean nothing on another screen.
  const carried = route.query.repo ? { repo: route.query.repo } : {}
  return (
    <div className="hub">
      <header className="hub-header">
        <h1>
          agentic-workflow hub <span className="beta-badge">beta</span>
        </h1>
        {/*
          Real links, not role="tab" buttons. The old markup announced a tablist
          it never implemented — no aria-controls, no roving tabindex, no arrow
          keys — while these are genuinely navigation: each section has an
          address, and `aria-current="page"` is the honest way to mark the one
          you're on.
        */}
        <nav className="hub-tabs" aria-label="Hub sections">
          {TABS.map((t) => (
            <Link
              key={t.id}
              to={buildHash({ screen: t.id, query: carried })}
              className={`hub-tab${route.screen === t.id ? " active" : ""}`}
              ariaCurrent={route.screen === t.id}
            >
              {t.label}
            </Link>
          ))}
        </nav>
        <RepoPicker />
        <HeaderStatus />
      </header>
      <main className="hub-main">
        {route.screen === "review" && <ReviewQueue />}
        {route.screen === "monitor" && <Monitor />}
        {route.screen === "creator" && <Creator />}
        {route.screen === "metrics" && <MetricsTab />}
        {route.screen === "config" && <ConfigEditor />}
      </main>
    </div>
  )
}

const root = document.getElementById("root")
if (root)
  createRoot(root).render(
    <StrictMode>
      <FeedbackProvider>
        <EventsProvider>
          <RepoProvider>
            <App />
          </RepoProvider>
        </EventsProvider>
      </FeedbackProvider>
    </StrictMode>,
  )
