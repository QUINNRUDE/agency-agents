import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, Bot, Copy, Search, Send, Square, UserRound } from "lucide-react";
import { api, stream, type Agent, type AgentMeta, type Contact, type ContactBundle } from "../lib/api.ts";
import { Markdown } from "../lib/markdown.tsx";
import { Banner, Card, Empty, LoadingRows, useAsync, useToast } from "../components/ui.tsx";
import { useApp } from "../App.tsx";

// Divisions most relevant to running a client business, shown first.
const PRIORITY = ["sales", "marketing", "paid-media", "support", "specialized", "project-management", "strategy", "finance", "product", "design"];

export function Agents() {
  const [params, setParams] = useSearchParams();
  const openSlug = params.get("open");
  const { playbooks } = useApp();
  const list = useAsync(() => api.get<{ agents: AgentMeta[] }>("/api/agents"));
  const [q, setQ] = useState("");
  const [division, setDivision] = useState("");

  const divisions = useMemo(() => {
    const m = new Map<string, { label: string; color: string; n: number }>();
    for (const a of list.data?.agents ?? []) {
      const d = m.get(a.division) ?? { label: a.divisionLabel, color: a.divisionColor, n: 0 };
      d.n++;
      m.set(a.division, d);
    }
    return [...m.entries()].sort((a, b) => {
      const ia = PRIORITY.indexOf(a[0]);
      const ib = PRIORITY.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a[1].label.localeCompare(b[1].label);
    });
  }, [list.data]);

  const filtered = useMemo(() => {
    const term = q.toLowerCase();
    const order = (d: string) => (PRIORITY.indexOf(d) < 0 ? 99 : PRIORITY.indexOf(d));
    return (list.data?.agents ?? [])
      .filter((a) => (!division || a.division === division) && (!term || `${a.name} ${a.description} ${a.vibe} ${a.divisionLabel}`.toLowerCase().includes(term)))
      .sort((a, b) => order(a.division) - order(b.division) || a.name.localeCompare(b.name));
  }, [list.data, q, division]);

  if (openSlug) return <AgentChat slug={openSlug} onBack={() => setParams({})} />;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Agents</h2>
          <p>Every specialist in the Agency Agents repo — {list.data?.agents.length ?? "…"} of them — ready to work on your clients. Pick one, attach a client, and ask.</p>
        </div>
      </div>

      <Card title="Wired into your workflow" sub="These run from client, call and prospect screens">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Playbook</th><th>Agent</th><th>Where</th></tr></thead>
            <tbody>
              {playbooks.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => setParams({ open: p.agentSlug })}>
                  <td><div style={{ fontWeight: 550 }}>{p.label}</div><div className="faint small">{p.summary}</div></td>
                  <td>{p.agentName}</td>
                  <td className="small muted">{p.id === "pipeline-review" ? "Pipeline" : p.id === "prospect-pitch" ? "Find clients" : ["objection", "call-summary", "cold-call-script"].includes(p.id) ? "Call workspace" : "Client profile, calls"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="row wrap">
        <div className="input-icon" style={{ width: 320 }}>
          <Search />
          <input className="input" placeholder="Search agents by name or skill" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="chips">
          <button className={`chip ${!division ? "on" : ""}`} onClick={() => setDivision("")}>All</button>
          {divisions.map(([id, d]) => (
            <button key={id} className={`chip ${division === id ? "on" : ""}`} onClick={() => setDivision(id)}>
              {d.label} <span className="faint num">{d.n}</span>
            </button>
          ))}
        </div>
      </div>

      {list.loading && !list.data ? (
        <Card><LoadingRows n={6} /></Card>
      ) : filtered.length ? (
        <div className="agents-grid">
          {filtered.map((a) => (
            <div key={a.slug} className="card agent-card" onClick={() => setParams({ open: a.slug })} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setParams({ open: a.slug })}>
              <div className="name">
                <span className="div-dot" style={{ background: a.divisionColor }} />
                <span className="ellipsis">{a.name}</span>
              </div>
              <div className="desc">{a.description}</div>
              <div className="faint small">{a.divisionLabel}</div>
            </div>
          ))}
        </div>
      ) : (
        <Card><Empty icon={<Bot />} title="No agents match" /></Card>
      )}
    </div>
  );
}

interface Turn {
  role: "user" | "assistant";
  content: string;
}

function AgentChat({ slug, onBack }: { slug: string; onBack: () => void }) {
  const { status } = useApp();
  const toast = useToast();
  const agent = useAsync(() => api.get<Agent>(`/api/agents/${slug}`), [slug]);
  const contacts = useAsync(() => api.get<Contact[]>("/api/contacts?limit=1000"));
  const [clientId, setClientId] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => stopRef.current?.(), []);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [turns]);

  const send = async () => {
    const text = input.trim();
    if (!text || running) return;
    setErr(null);
    let content = text;
    if (clientId && !turns.length) {
      try {
        const b = await api.get<ContactBundle>(`/api/contacts/${clientId}`);
        const c = b.contact;
        content = `${text}\n\n---\nClient context from my CRM:\n- ${c.name}${c.companyName ? `, ${c.companyName}` : ""} (${[c.city, c.state].filter(Boolean).join(", ") || "location unknown"})\n- Email ${c.email || "—"}, phone ${c.phone || "—"}, website ${c.website || "none"}\n- Source ${c.source || "—"}; tags ${c.tags.join(", ") || "—"}\n- Deals: ${b.opportunities.map((o) => `${o.name} ($${o.value}, ${o.status})`).join("; ") || "none"}\n- Notes:\n${b.notes.slice(0, 8).map((n) => `  - ${n.body.replace(/\n+/g, " ").slice(0, 400)}`).join("\n") || "  - none"}\n- Calls: ${b.calls.slice(0, 5).map((cl) => `${cl.outcome}: ${cl.notes.slice(0, 200)}`).join(" | ") || "none"}`;
      } catch {
        /* send without context */
      }
    }
    const next: Turn[] = [...turns, { role: "user", content }, { role: "assistant", content: "" }];
    setTurns(next);
    setInput("");
    setRunning(true);
    stopRef.current = stream(
      "/api/ai/run",
      { agentSlug: slug, messages: next.slice(0, -1) },
      {
        onDelta: (t) => setTurns((ts) => ts.map((x, i) => (i === ts.length - 1 ? { ...x, content: x.content + t } : x))),
        onDone: () => setRunning(false),
        onError: (m) => {
          setErr(m);
          setRunning(false);
          setTurns((ts) => (ts[ts.length - 1]?.content ? ts : ts.slice(0, -2)));
        },
      },
    );
  };

  const a = agent.data;
  const client = contacts.data?.find((c) => c.id === clientId);

  return (
    <div className="page">
      <div className="row">
        <button className="btn ghost sm" onClick={onBack}><ArrowLeft /> All agents</button>
      </div>
      {agent.error && <Banner tone="bad">{agent.error}</Banner>}
      <div className="split">
        <div className="stack" style={{ gap: 16 }}>
          <Card>
            {a ? (
              <div className="stack" style={{ gap: 8 }}>
                <div className="row"><span className="div-dot" style={{ background: a.divisionColor }} /><span className="faint small">{a.divisionLabel}</span></div>
                <div style={{ fontWeight: 650, fontSize: 17 }}>{a.name}</div>
                <div className="small muted">{a.description}</div>
                {a.vibe && <div className="small" style={{ fontStyle: "italic" }}>“{a.vibe}”</div>}
                <div className="faint small mono">{a.path}</div>
                <button className="btn sm ghost" style={{ justifySelf: "start" }} onClick={() => setShowPrompt((s) => !s)}>{showPrompt ? "Hide" : "View"} full playbook</button>
              </div>
            ) : (
              <LoadingRows n={4} />
            )}
          </Card>
          <Card title={<span className="row" style={{ gap: 6 }}><UserRound size={14} /> Attach a client</span>}>
            <div className="stack">
              <select className="select" value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={turns.length > 0}>
                <option value="">No client — general question</option>
                {contacts.data?.map((c) => <option key={c.id} value={c.id}>{c.name}{c.companyName ? ` · ${c.companyName}` : ""}</option>)}
              </select>
              <div className="faint small">{turns.length ? "Start a new conversation to change the client." : "Their profile, deals, notes and calls are sent with your first message."}</div>
              {client && <Link to={`/clients/${client.id}`} className="small">Open {client.name} →</Link>}
            </div>
          </Card>
          {turns.length > 0 && <button className="btn" onClick={() => (stopRef.current?.(), setTurns([]), setRunning(false))}>New conversation</button>}
        </div>

        <section className="card chat">
          {showPrompt && a ? (
            <div className="chat-log"><Markdown text={a.body} /></div>
          ) : (
            <div className="chat-log" ref={logRef}>
              {!turns.length && (
                <Empty icon={<Bot />} title={a ? `Ask ${a.name}` : "Loading agent"}>
                  {a && (client ? `It will see ${client.name}'s CRM history.` : "Attach a client on the left to ground the answer in your CRM.")}
                </Empty>
              )}
              {turns.map((t, i) =>
                t.role === "user" ? (
                  <div className="msg-user" key={i}>{t.content.split("\n\n---\nClient context")[0]}{t.content.includes("Client context from my CRM") && <div className="faint small" style={{ marginTop: 4 }}>+ client context</div>}</div>
                ) : (
                  <div key={i} style={{ display: "grid", gap: 6 }}>
                    {t.content ? <Markdown text={t.content} streaming={running && i === turns.length - 1} /> : <span className="faint small caret">Thinking</span>}
                    {t.content && !(running && i === turns.length - 1) && (
                      <button className="btn sm ghost" style={{ justifySelf: "start" }} onClick={() => navigator.clipboard.writeText(t.content).then(() => toast("Copied"))}><Copy /> Copy</button>
                    )}
                  </div>
                ),
              )}
              {err && <Banner tone="bad">{err}</Banner>}
            </div>
          )}
          <div className="chat-input">
            {!status?.has.claude && <Banner tone="info">Agents run on Claude. <Link to="/settings#claude">Add your Anthropic API key</Link> to start.</Banner>}
            <textarea
              className="textarea"
              rows={3}
              placeholder={a ? `Message ${a.name}…  (Enter to send, Shift+Enter for a new line)` : ""}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              disabled={!status?.has.claude}
            />
            <div className="row">
              <span className="faint small">{client ? `With ${client.name}'s context` : "No client attached"}</span>
              <span className="spacer" />
              {running ? (
                <button className="btn" onClick={() => (stopRef.current?.(), setRunning(false))}><Square /> Stop</button>
              ) : (
                <button className="btn primary" onClick={send} disabled={!input.trim() || !status?.has.claude}><Send /> Send</button>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
