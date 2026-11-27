import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { FlaskConical, Inbox as InboxIcon, Search, Send, UserRound, WandSparkles, Workflow } from "lucide-react";
import { api, type Contact, type Message } from "../lib/api.ts";
import { relTime } from "../lib/format.ts";
import { useApp } from "../App.tsx";
import { Avatar, Banner, Empty, LoadingRows, useAsync, useToast } from "../components/ui.tsx";
import { CHANNEL_NAMES, ChannelBadge, ChannelIcon } from "../components/brand.tsx";

interface Conversation {
  id: string;
  contactId: string;
  contactName: string;
  lastMessageBody: string;
  lastMessageDate: string;
  lastMessageDirection: "inbound" | "outbound";
  channel: string;
  unread: number;
}

interface Thread {
  contact: Contact;
  messages: Message[];
  lastInbound: Record<string, string>;
}

const FILTERS = [
  { id: "all", label: "All" },
  { id: "unread", label: "Needs reply" },
  { id: "SMS", label: "Texts" },
  { id: "DM", label: "DMs" },
  { id: "Email", label: "Email" },
] as const;

const SEND = ["SMS", "IG", "FB", "WhatsApp", "Email"] as const;
type SendCh = (typeof SEND)[number];
const DAY = 86_400_000;

function windowLeft(iso?: string) {
  if (!iso) return 0;
  return Math.max(0, Date.parse(iso) + DAY - Date.now());
}

export function Inbox() {
  const { contactId } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { status } = useApp();
  const list = useAsync(() => api.get<Conversation[]>("/api/inbox?limit=80"));
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [q, setQ] = useState("");
  const thread = useAsync(() => (contactId ? api.get<Thread>(`/api/inbox/${contactId}`) : Promise.resolve(null)), [contactId]);
  const [channel, setChannel] = useState<SendCh>("SMS");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [sim, setSim] = useState<{ open: boolean; channel: string; body: string }>({ open: false, channel: "IG", body: "Hi! How much does it cost to work with you?" });
  const bodyRef = useRef<HTMLDivElement>(null);

  // Live refresh so automated replies show up without reloading.
  useEffect(() => {
    const t = setInterval(() => {
      void list.reload();
      if (contactId) void thread.reload();
    }, 12_000);
    return () => clearInterval(t);
  }, [contactId, list.reload, thread.reload]);

  useEffect(() => {
    if (!contactId && list.data?.[0] && window.innerWidth > 1080) nav(`/inbox/${list.data[0].contactId}`, { replace: true });
  }, [contactId, list.data, nav]);

  // Default the composer to the channel they last wrote on (if we're allowed to reply there).
  useEffect(() => {
    const t = thread.data;
    if (!t) return;
    const lastIn = [...t.messages].reverse().find((m) => m.direction === "inbound");
    const ch = (lastIn?.channel ?? (t.contact.phone ? "SMS" : "Email")) as SendCh;
    setChannel(SEND.includes(ch) ? ch : "SMS");
    setText("");
    setSubject("");
  }, [thread.data?.contact.id]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [thread.data?.messages.length]);

  const rows = useMemo(() => {
    const term = q.toLowerCase();
    return (list.data ?? []).filter((c) => {
      if (term && !`${c.contactName} ${c.lastMessageBody}`.toLowerCase().includes(term)) return false;
      if (filter === "unread") return c.lastMessageDirection === "inbound";
      if (filter === "DM") return c.channel === "FB" || c.channel === "IG" || c.channel === "WhatsApp";
      if (filter === "SMS" || filter === "Email") return c.channel === filter;
      return true;
    });
  }, [list.data, filter, q]);

  const t = thread.data;
  const blocked = (ch: SendCh): string | null => {
    if (!t) return "No conversation selected";
    if ((ch === "SMS" || ch === "WhatsApp") && !t.contact.phone) return "No phone number";
    if (ch === "Email" && !t.contact.email) return "No email address";
    if ((ch === "FB" || ch === "IG") && !windowLeft(t.lastInbound[ch])) return "Meta's 24-hour window is closed";
    return null;
  };

  const send = async () => {
    if (!t || !text.trim()) return;
    setSending(true);
    try {
      const r = await api.post<{ delivered: boolean }>("/api/messages", { contactId: t.contact.id, channel, body: text.trim(), subject: channel === "Email" ? subject || "Following up" : undefined });
      toast(r.delivered ? `Sent via ${CHANNEL_NAMES[channel]}` : "Saved here, not sent (GoHighLevel isn't connected)");
      setText("");
      void thread.reload();
      void list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Send failed", "bad");
    } finally {
      setSending(false);
    }
  };

  const draft = async () => {
    if (!t) return;
    setDrafting(true);
    try {
      const r = await api.post<{ text: string; handoff: boolean }>("/api/ai/draft", { contactId: t.contact.id, channel });
      if (r.handoff) toast("This one needs a human touch — the AI suggests you reply personally.", "bad");
      else setText(r.text);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Draft failed", "bad");
    } finally {
      setDrafting(false);
    }
  };

  const simulate = async () => {
    if (!t) return;
    try {
      await api.post("/api/inbox/simulate", { contactId: t.contact.id, channel: sim.channel, body: sim.body });
      toast("Simulated message received — automations will pick it up in a few seconds");
      setSim({ ...sim, open: false });
      void thread.reload();
      void list.reload();
      setTimeout(() => (void thread.reload(), void list.reload()), 4000);
      setTimeout(() => (void thread.reload(), void list.reload()), 9000);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not simulate", "bad");
    }
  };

  const dmLeft = t ? Math.max(windowLeft(t.lastInbound.IG), windowLeft(t.lastInbound.FB)) : 0;

  return (
    <div className="page" style={{ maxWidth: 1500 }}>
      <div className="page-head">
        <div>
          <h2>Inbox</h2>
          <p>Texts, emails, Instagram and Messenger DMs in one place. Replies from your automations appear here live.</p>
        </div>
        <div className="actions">
          <Link className="btn" to="/automations"><Workflow /> Automations</Link>
        </div>
      </div>

      <section className="card inbox">
        <div className="inbox-list">
          <div style={{ padding: 12, display: "grid", gap: 8, borderBottom: "1px solid var(--border)", position: "sticky", top: 0, background: "var(--surface)", zIndex: 1 }}>
            <div className="input-icon">
              <Search />
              <input className="input" placeholder="Search conversations" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="chips">
              {FILTERS.map((f) => (
                <button key={f.id} className={`chip ${filter === f.id ? "on" : ""}`} onClick={() => setFilter(f.id)} style={{ padding: "3px 9px", fontSize: 12 }}>{f.label}</button>
              ))}
            </div>
          </div>
          {list.loading && !list.data ? (
            <LoadingRows n={8} />
          ) : rows.length ? (
            rows.map((c) => (
              <div key={c.id} className={`conv ${c.contactId === contactId ? "on" : ""}`} onClick={() => nav(`/inbox/${c.contactId}`)}>
                <Avatar name={c.contactName} />
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <span className="n ellipsis">{c.contactName}</span>
                    <span style={{ color: "var(--text-3)", display: "inline-flex" }}><ChannelIcon channel={c.channel} /></span>
                  </div>
                  <div className="p">{c.lastMessageDirection === "outbound" ? "You: " : ""}{c.lastMessageBody || "—"}</div>
                </div>
                <div style={{ display: "grid", justifyItems: "end", gap: 6 }}>
                  <span className="faint small" style={{ whiteSpace: "nowrap" }}>{relTime(c.lastMessageDate)}</span>
                  {c.lastMessageDirection === "inbound" && <span className="unread-dot" title="Waiting on a reply" />}
                </div>
              </div>
            ))
          ) : (
            <Empty icon={<InboxIcon />} title="No conversations">Messages from GoHighLevel show up here.</Empty>
          )}
        </div>

        <div className="thread">
          {!contactId ? (
            <Empty icon={<InboxIcon />} title="Pick a conversation" />
          ) : thread.loading && !t ? (
            <LoadingRows n={6} />
          ) : !t ? (
            <Empty title="Conversation not found" />
          ) : (
            <>
              <div className="thread-head">
                <Avatar name={t.contact.name} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 650 }}>{t.contact.name}</div>
                  <div className="faint small ellipsis">{[t.contact.companyName !== t.contact.name && t.contact.companyName, t.contact.phone, t.contact.email].filter(Boolean).join(" · ")}</div>
                </div>
                <span className="spacer" />
                {dmLeft > 0 ? (
                  <span className="badge good" title="Meta allows business replies within 24 hours of the person's last DM">DM window open · {Math.ceil(dmLeft / 3_600_000)}h left</span>
                ) : (t.lastInbound.IG || t.lastInbound.FB) ? (
                  <span className="badge" title="Meta only allows business messages within 24 hours of their last DM">DM window closed</span>
                ) : null}
                {status?.crm.mode === "demo" && status.demoData !== false && (
                  <button className="btn sm" onClick={() => setSim({ ...sim, open: !sim.open })}><FlaskConical /> Simulate incoming</button>
                )}
                <Link className="btn sm ghost" to={`/clients/${t.contact.id}`}><UserRound /> Profile</Link>
              </div>
              {sim.open && (
                <div style={{ padding: 12, borderBottom: "1px solid var(--border)", background: "var(--surface-2)" }} className="row wrap">
                  <span className="small muted">Pretend {t.contact.firstName || t.contact.name} sent:</span>
                  <select className="select" style={{ width: 130, height: 30 }} value={sim.channel} onChange={(e) => setSim({ ...sim, channel: e.target.value })}>
                    <option value="IG">Instagram</option>
                    <option value="FB">Messenger</option>
                    <option value="SMS">SMS</option>
                    <option value="WhatsApp">WhatsApp</option>
                  </select>
                  <input className="input" style={{ flex: 1, minWidth: 200, height: 30 }} value={sim.body} onChange={(e) => setSim({ ...sim, body: e.target.value })} />
                  <button className="btn sm primary" onClick={simulate}>Receive</button>
                </div>
              )}
              <div className="thread-body" ref={bodyRef}>
                {t.messages.length ? (
                  t.messages.map((m, i) => {
                    const prev = t.messages[i - 1];
                    const showMeta = !prev || prev.direction !== m.direction || prev.channel !== m.channel || Date.parse(m.dateAdded) - Date.parse(prev.dateAdded) > 3_600_000;
                    return (
                      <div key={m.id} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        {showMeta && (
                          <div className={`bubble-meta ${m.direction === "outbound" ? "out" : ""}`}>
                            <ChannelBadge channel={m.channel} /> {new Date(m.dateAdded).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                          </div>
                        )}
                        <div className={`bubble ${m.direction === "inbound" ? "in" : "out"}`}>{m.body || <i style={{ opacity: 0.7 }}>({m.channel})</i>}</div>
                      </div>
                    );
                  })
                ) : (
                  <Empty title="No messages yet">Start the conversation below.</Empty>
                )}
              </div>
              <div className="composer">
                <div className="row wrap" style={{ gap: 6 }}>
                  {SEND.map((ch) => {
                    const why = blocked(ch);
                    return (
                      <button key={ch} className={`chip ${channel === ch ? "on" : ""}`} disabled={Boolean(why)} title={why ?? `Send as ${CHANNEL_NAMES[ch]}`} onClick={() => setChannel(ch)} style={{ opacity: why ? 0.45 : 1, display: "inline-flex", gap: 5, alignItems: "center" }}>
                        <ChannelIcon channel={ch} /> {CHANNEL_NAMES[ch]}
                      </button>
                    );
                  })}
                </div>
                {blocked(channel) && <Banner tone="warn">{blocked(channel)}{(channel === "IG" || channel === "FB") && " — Meta only allows business messages within 24 hours of the person's last DM. Text or email them instead."}</Banner>}
                {channel === "Email" && <input className="input" placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />}
                <textarea
                  className="textarea"
                  rows={3}
                  placeholder={`Message ${t.contact.firstName || t.contact.name} on ${CHANNEL_NAMES[channel]}…  (⌘↵ to send)`}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && void send()}
                />
                <div className="row">
                  <button className="btn" onClick={draft} disabled={drafting || !status?.has.claude} title={status?.has.claude ? "Let the AI write a reply from the conversation" : "Connect Claude in Settings"}>
                    <WandSparkles /> {drafting ? "Writing…" : "AI draft"}
                  </button>
                  <span className="faint small">{channel === "SMS" && text ? `${text.length} chars · ${Math.max(1, Math.ceil(text.length / 160))} segment${text.length > 160 ? "s" : ""}` : ""}</span>
                  <span className="spacer" />
                  <button className="btn primary" onClick={send} disabled={sending || !text.trim() || Boolean(blocked(channel))}>
                    <Send /> {sending ? "Sending…" : "Send"}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
