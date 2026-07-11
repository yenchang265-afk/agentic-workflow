import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { Creator } from "./creator/Creator.js"
import { EventsProvider, useEvents } from "./events.js"
import { Manual } from "./Manual.js"
import { ActivePanel } from "./monitor/ActivePanel.js"
import { Board } from "./monitor/Board.js"
import { Runs } from "./monitor/Runs.js"
import { RepoPicker, RepoProvider } from "./repo.js"
import "./theme.css"

type Tab = "monitor" | "creator" | "manual"

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "monitor", label: "Loop monitor" },
  { id: "creator", label: "Loop creator" },
  { id: "manual", label: "User manual" },
]

const HeaderStatus = () => {
  const { connected, notifications, requestNotifications } = useEvents()
  return (
    <div className="header-status">
      <span className={`live-dot${connected ? " on" : ""}`} title={connected ? "live updates on" : "reconnecting…"} />
      {notifications !== "unsupported" && notifications !== "granted" && (
        <button className="hub-tab" title="Notify me when a task parks at a gate" onClick={requestNotifications}>
          🔔 notify
        </button>
      )}
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
        {tab === "monitor" && (
          <div>
            <ActivePanel />
            <Board />
            <h2 className="section-title">Run history</h2>
            <Runs />
          </div>
        )}
        {tab === "creator" && <Creator />}
        {tab === "manual" && <Manual />}
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
