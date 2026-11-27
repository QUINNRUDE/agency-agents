import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Bot, Building2, Columns3, LayoutDashboard, Moon, Phone, Search, Settings as SettingsIcon, Sun, Telescope, Users } from "lucide-react";
import { api, type Contact, type Playbook, type Status } from "./lib/api.ts";
import { ToastProvider } from "./components/ui.tsx";
import { Overview } from "./pages/Overview.tsx";
import { Clients } from "./pages/Clients.tsx";
import { ClientDetail } from "./pages/ClientDetail.tsx";
import { PipelinePage } from "./pages/Pipeline.tsx";
import { Prospecting } from "./pages/Prospecting.tsx";
import { Calls } from "./pages/Calls.tsx";
import { CallWorkspace } from "./pages/CallWorkspace.tsx";
import { Agents } from "./pages/Agents.tsx";
import { Settings } from "./pages/Settings.tsx";

interface AppCtx {
  status: Status | null;
  playbooks: Playbook[];
  agentCount: number;
  refreshStatus: () => void;
}
const Ctx = createContext<AppCtx>({ status: null, playbooks: [], agentCount: 0, refreshStatus: () => {} });
export const useApp = () => useContext(Ctx);

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/clients", label: "Clients", icon: Users },
  { to: "/pipeline", label: "Pipeline", icon: Columns3 },
  { to: "/prospecting", label: "Find clients", icon: Telescope },
  { to: "/calls", label: "Calls", icon: Phone },
  { to: "/agents", label: "Agents", icon: Bot },
];

const TITLES: Record<string, string> = {
  "": "Overview",
  clients: "Clients",
  pipeline: "Pipeline",
  prospecting: "Find clients",
  calls: "Calls",
  agents: "Agents",
  settings: "Settings",
};

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(() => {
    try {
      const v = localStorage.getItem("clientline-theme");
      return v === "light" || v === "dark" ? v : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    try {
      if (theme) localStorage.setItem("clientline-theme", theme);
    } catch {
      /* storage unavailable */
    }
  }, [theme]);
  const isDark = theme ? theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  return { isDark, toggle: () => setTheme(isDark ? "light" : "dark") };
}

function Palette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [sel, setSel] = useState(0);
  const nav = useNavigate();
  useEffect(() => {
    const t = setTimeout(() => {
      api.get<Contact[]>(`/api/contacts?limit=8&q=${encodeURIComponent(q)}`).then(setContacts, () => setContacts([]));
    }, 140);
    return () => clearTimeout(t);
  }, [q]);
  const pages = [...NAV, { to: "/settings", label: "Settings", icon: SettingsIcon }].filter((n) => n.label.toLowerCase().includes(q.toLowerCase()));
  const items = [
    ...contacts.map((c) => ({ key: c.id, label: c.name, sub: c.companyName, icon: Users, go: () => nav(`/clients/${c.id}`), group: "Clients" })),
    ...contacts.slice(0, 3).filter((c) => c.phone).map((c) => ({ key: `call-${c.id}`, label: `Call ${c.name}`, sub: c.companyName, icon: Phone, go: () => nav(`/calls/${c.id}`), group: "Actions" })),
    ...pages.map((p) => ({ key: p.to, label: p.label, sub: "", icon: p.icon, go: () => nav(p.to), group: "Go to" })),
  ];
  const choose = (i: number) => {
    items[i]?.go();
    onClose();
  };
  let lastGroup = "";
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Search">
        <input
          autoFocus
          placeholder="Search clients, jump to a page…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(items.length - 1, s + 1)));
            if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(0, s - 1)));
            if (e.key === "Enter") choose(sel);
          }}
        />
        <div className="palette-list">
          {items.map((it, i) => {
            const header = it.group !== lastGroup ? <div className="palette-group">{it.group}</div> : null;
            lastGroup = it.group;
            const Icon = it.icon;
            return (
              <div key={it.key}>
                {header}
                <div className={`palette-item ${i === sel ? "sel" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => choose(i)}>
                  <Icon />
                  <span>{it.label}</span>
                  {it.sub && <span className="faint small">{it.sub}</span>}
                </div>
              </div>
            );
          })}
          {!items.length && <div className="empty small">No matches</div>}
        </div>
      </div>
    </div>
  );
}

function Shell() {
  const { status } = useApp();
  const loc = useLocation();
  const [palette, setPalette] = useState(false);
  const theme = useTheme();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const seg = loc.pathname.split("/")[1] ?? "";
  const title = TITLES[seg] ?? "Clientline";
  const mode = status?.crm.mode;
  const connected = status?.ok && mode === "ghl";

  return (
    <div className="shell">
      <aside className="side">
        <Link to="/" className="brand" style={{ textDecoration: "none" }}>
          <span className="brand-mark">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
              <path d="M2 13V3h2.6v7.6H9V13z" fill="#111315" />
              <circle cx="12.4" cy="11.2" r="1.8" fill="#257de0" />
            </svg>
          </span>
          <span>
            <div className="brand-name">Clientline</div>
            <div className="brand-sub">{status?.crm.accountName || "Client command center"}</div>
          </span>
        </Link>
        <div className="nav-label">Workspace</div>
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
            <Icon /> {label}
          </NavLink>
        ))}
        <div className="nav-label">Account</div>
        <NavLink to="/settings" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
          <SettingsIcon /> Settings
        </NavLink>
        <div className="side-foot">
          <Link to="/settings#ghl" className="conn" style={{ textDecoration: "none" }}>
            <span className={`dot ${connected ? "on" : status && !status.ok ? "off" : "demo"}`} />
            <span>
              {connected ? "GoHighLevel connected" : status && !status.ok ? "GoHighLevel error" : "Demo workspace"}
              <small>{connected ? status?.crm.accountName : status && !status.ok ? "Check Settings" : "Connect GoHighLevel →"}</small>
            </span>
          </Link>
          <Link to="/settings#claude" className="conn" style={{ textDecoration: "none" }}>
            <span className={`dot ${status?.has.claude ? "on" : ""}`} />
            <span>
              {status?.has.claude ? "Claude connected" : "Claude not connected"}
              <small>{status?.has.claude ? "Agent playbooks on" : "Add API key →"}</small>
            </span>
          </Link>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <h1>{title}</h1>
          {mode === "demo" && <span className="badge warn">Demo data</span>}
          <button className="search-trigger" onClick={() => setPalette(true)} aria-label="Search">
            <Search size={15} />
            <span>Search clients or jump to…</span>
            <kbd>⌘K</kbd>
          </button>
          <button className="btn ghost icon" onClick={theme.toggle} aria-label="Toggle theme" title="Toggle theme">
            {theme.isDark ? <Sun /> : <Moon />}
          </button>
        </header>
        <nav className="mobile-nav">
          {[...NAV, { to: "/settings", label: "Settings", icon: SettingsIcon, end: false }].map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? "active" : "")}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <main className="content">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/clients" element={<Clients />} />
            <Route path="/clients/:id" element={<ClientDetail />} />
            <Route path="/pipeline" element={<PipelinePage />} />
            <Route path="/prospecting" element={<Prospecting />} />
            <Route path="/calls" element={<Calls />} />
            <Route path="/calls/:id" element={<CallWorkspace />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/settings" element={<Settings />} />
            <Route
              path="*"
              element={
                <div className="empty">
                  <Building2 />
                  <strong>Page not found</strong>
                  <Link to="/">Back to overview</Link>
                </div>
              }
            />
          </Routes>
        </main>
      </div>
      {palette && <Palette onClose={() => setPalette(false)} />}
    </div>
  );
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [agentCount, setAgentCount] = useState(0);
  const refreshStatus = useCallback(() => {
    api.get<Status>("/api/status").then(setStatus, () => setStatus(null));
  }, []);
  useEffect(() => {
    refreshStatus();
    api.get<{ playbooks: Playbook[]; agents: unknown[] }>("/api/agents").then((d) => {
      setPlaybooks(d.playbooks);
      setAgentCount(d.agents.length);
    });
  }, [refreshStatus]);
  const value = useMemo(() => ({ status, playbooks, agentCount, refreshStatus }), [status, playbooks, agentCount, refreshStatus]);
  return (
    <Ctx.Provider value={value}>
      <ToastProvider>
        <BrowserRouter>
          <Shell />
        </BrowserRouter>
      </ToastProvider>
    </Ctx.Provider>
  );
}
