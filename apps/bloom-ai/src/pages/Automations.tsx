import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  CalendarCheck,
  CheckSquare,
  Clock,
  Columns3,
  Copy,
  Eye,
  FlaskConical,
  Hourglass,
  Megaphone,
  MessageSquare,
  Pencil,
  Phone,
  Plus,
  Snowflake,
  Sparkles,
  Star,
  Tag,
  Trash2,
  UserPlus,
  Workflow,
  Zap,
} from "lucide-react";
import { api, type Contact, type Pipeline } from "../lib/api.ts";
import { relTime } from "../lib/format.ts";
import { useApp } from "../App.tsx";
import { Banner, Card, Empty, Field, LoadingRows, Modal, useAsync, useToast } from "../components/ui.tsx";
import { ConfirmModal, ContactPicker } from "../components/crm.tsx";
import { CHANNEL_NAMES, ChannelBadge, ChannelIcon, Toggle } from "../components/brand.tsx";

// ---- Types mirrored from server/automations.ts ----
type TriggerType = "new_contact" | "meta_lead" | "inbound_message" | "tag_added" | "stage_changed" | "deal_idle" | "call_logged" | "manual";
interface Trigger {
  type: TriggerType;
  tag?: string;
  stageId?: string;
  channel?: string;
  keyword?: string;
  days?: number;
  outcome?: string;
  formName?: string;
  includeProspects?: boolean;
}
type StepType = "wait" | "send" | "add_tag" | "remove_tag" | "create_task" | "move_stage";
interface Step {
  id: string;
  type: StepType;
  amount?: number;
  unit?: "minutes" | "hours" | "days";
  channel?: string;
  mode?: "template" | "ai";
  text?: string;
  subject?: string;
  instructions?: string;
  agentSlug?: string;
  tag?: string;
  title?: string;
  dueInDays?: number;
  stageId?: string;
}
interface Automation {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger: Trigger;
  steps: Step[];
  exitOnReply: boolean;
  createdAt: string;
  updatedAt: string;
  stats: { enrolled: number; sent: number; skipped: number; failed: number; handoffs: number };
}
interface EngineSettings {
  enabled: boolean;
  dryRun: boolean;
  quietStart: string;
  quietEnd: string;
  timezone: string;
  maxPerContactPerDay: number;
  maxPerDay: number;
  webhookSecret: string;
}
interface Recipe {
  recipeId: string;
  icon: string;
  name: string;
  description: string;
  trigger: Trigger;
  needs?: string;
}
interface State {
  settings: EngineSettings;
  automations: Automation[];
  status: { seeded: boolean; lastPoll: string; lastError: string; activeRuns: number; nextRunAt: string | null; sent24h: number };
  recipes: Recipe[];
}
interface LogRow {
  id: string;
  at: string;
  automationId: string;
  automationName: string;
  contactId: string;
  contactName: string;
  channel: string;
  body: string;
  status: "sent" | "demo" | "dry_run" | "skipped" | "failed" | "handoff" | "action";
  reason: string;
  ai: boolean;
}

const TRIGGERS: { type: TriggerType; label: string; icon: typeof Zap; hint: string }[] = [
  { type: "new_contact", label: "New contact added", icon: UserPlus, hint: "Any new contact in GoHighLevel — forms, imports, ads, manual." },
  { type: "meta_lead", label: "Meta lead form submitted", icon: Megaphone, hint: "A Facebook / Instagram Lead Ad submission synced into the CRM." },
  { type: "inbound_message", label: "Message received", icon: MessageSquare, hint: "Someone texts, emails or DMs you." },
  { type: "tag_added", label: "Tag added", icon: Tag, hint: "A tag is added to a contact (also by your GHL workflows)." },
  { type: "stage_changed", label: "Deal moves to stage", icon: Columns3, hint: "A deal enters a pipeline stage." },
  { type: "deal_idle", label: "Deal goes quiet", icon: Snowflake, hint: "An open deal sits in one stage for N days." },
  { type: "call_logged", label: "Call logged", icon: Phone, hint: "You log a call in Bloom AI with a given outcome." },
  { type: "manual", label: "Manual enrollment only", icon: Workflow, hint: "Only contacts you enroll by hand." },
];

const RECIPE_ICON: Record<string, typeof Zap> = { zap: Zap, megaphone: Megaphone, instagram: MessageSquare, message: MessageSquare, snowflake: Snowflake, calendar: CalendarCheck, star: Star };
const RECIPE_TINT: Record<string, string> = { zap: "rose", megaphone: "sky", instagram: "violet", message: "teal", snowflake: "sky", calendar: "amber", star: "amber" };

const AGENTS = [
  { slug: "sales-outreach", label: "Sales Outreach (default)" },
  { slug: "sales-discovery-coach", label: "Discovery Coach — qualifies" },
  { slug: "support-support-responder", label: "Support Responder — existing clients" },
  { slug: "customer-success-manager", label: "Customer Success Manager" },
];

const MERGE = ["first_name", "last_name", "company", "city", "my_name", "agency", "booking_link"];

const newId = () => `st_${Math.random().toString(36).slice(2, 10)}`;

function triggerSummary(t: Trigger, stages: Map<string, string>): string {
  switch (t.type) {
    case "tag_added":
      return `Tag “${t.tag || "?"}” added`;
    case "stage_changed":
      return `Deal → ${stages.get(t.stageId ?? "") ?? "pick a stage"}`;
    case "deal_idle":
      return `Deal idle ${t.days ?? 14}+ days`;
    case "inbound_message":
      return `${t.channel === "DM" ? "DM" : t.channel && t.channel !== "any" ? (CHANNEL_NAMES[t.channel] ?? t.channel) : "Message"} received${t.keyword ? ` containing “${t.keyword}”` : ""}`;
    case "call_logged":
      return `Call logged${t.outcome && t.outcome !== "any" ? ` · ${t.outcome.replace(/_/g, " ")}` : ""}`;
    case "meta_lead":
      return `Meta lead${t.formName ? ` · “${t.formName}”` : ""}`;
    default:
      return TRIGGERS.find((x) => x.type === t.type)?.label ?? t.type;
  }
}

function stepSummary(s: Step, stages: Map<string, string>) {
  if (s.type === "wait") return { icon: <Hourglass />, text: `Wait ${s.amount ?? 1} ${s.unit ?? "days"}` };
  if (s.type === "send") return { icon: s.mode === "ai" ? <Sparkles /> : <ChannelIcon channel={s.channel === "reply" ? "SMS" : (s.channel ?? "SMS")} />, text: `${s.mode === "ai" ? "AI " : ""}${s.channel === "reply" ? "reply" : (CHANNEL_NAMES[s.channel ?? "SMS"] ?? s.channel)}` };
  if (s.type === "add_tag") return { icon: <Tag />, text: `+ ${s.tag || "tag"}` };
  if (s.type === "remove_tag") return { icon: <Tag />, text: `− ${s.tag || "tag"}` };
  if (s.type === "create_task") return { icon: <CheckSquare />, text: "Task" };
  return { icon: <Columns3 />, text: `→ ${stages.get(s.stageId ?? "") ?? "stage"}` };
}

const STATUS_BADGE: Record<LogRow["status"], { cls: string; label: string }> = {
  sent: { cls: "good", label: "Sent" },
  demo: { cls: "accent", label: "Sent (demo)" },
  dry_run: { cls: "warn", label: "Test mode" },
  skipped: { cls: "", label: "Skipped" },
  failed: { cls: "bad", label: "Failed" },
  handoff: { cls: "warn", label: "Handed to you" },
  action: { cls: "", label: "Action" },
};

export function Automations() {
  const { status: appStatus } = useApp();
  const toast = useToast();
  const state = useAsync(() => api.get<State>("/api/automations"));
  const pipelines = useAsync(() => api.get<Pipeline[]>("/api/pipelines"));
  const profile = useAsync(() => api.get<{ profile: Record<string, string> }>("/api/settings"));
  const [tab, setTab] = useState<"automations" | "log" | "settings">("automations");
  const [editing, setEditing] = useState<Automation | null>(null);
  const [deleting, setDeleting] = useState<Automation | null>(null);
  const log = useAsync(() => (tab === "log" ? api.get<LogRow[]>("/api/automation-log?limit=300") : Promise.resolve(null)), [tab]);

  useEffect(() => {
    const t = setInterval(() => {
      void state.reload();
      if (tab === "log") void log.reload();
    }, 10_000);
    return () => clearInterval(t);
  }, [tab, state.reload, log.reload]);

  const stages = useMemo(() => new Map((pipelines.data ?? []).flatMap((p) => p.stages.map((s) => [s.id, `${s.name}`] as const))), [pipelines.data]);
  const s = state.data;
  const live = s?.settings.enabled && s.automations.some((a) => a.enabled);
  const profileMissing = profile.data && !profile.data.profile.yourName && !profile.data.profile.agencyName;

  const toggle = async (a: Automation, enabled: boolean) => {
    try {
      await api.put(`/api/automations/${a.id}`, { enabled });
      toast(enabled ? `“${a.name}” is live` : `“${a.name}” paused`);
      void state.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not update", "bad");
      if (enabled) setEditing(a);
    }
  };

  const install = async (r: Recipe) => {
    try {
      const a = await api.post<Automation>("/api/automations", { recipeId: r.recipeId });
      void state.reload();
      setEditing(a);
      toast(`Added “${a.name}” — review it, then switch it on`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not add", "bad");
    }
  };

  const saveSettings = async (patch: Partial<EngineSettings>) => {
    try {
      const next = await api.put<EngineSettings>("/api/automation-settings", patch);
      state.setData((d) => (d ? { ...d, settings: next } : d));
      toast("Automation settings saved");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not save", "bad");
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Automations</h2>
          <p>Texts, emails and Instagram / Messenger / WhatsApp DMs that send themselves — from templates or written by AI — with opt-outs, quiet hours and limits built in.</p>
        </div>
        <div className="actions">
          {s && (
            <span className={`status-pill ${!s.settings.enabled ? "off" : s.settings.dryRun ? "test" : !live ? "off" : ""}`}>
              {s.settings.enabled && !s.settings.dryRun && live && <span className="pulse-ring" />}
              {!s.settings.enabled ? "All automations paused" : s.settings.dryRun ? "Test mode — nothing sends" : live ? "Live" : "No automations on"}
            </span>
          )}
          <button
            className="btn primary"
            onClick={async () => {
              const a = await api.post<Automation>("/api/automations", { name: "New automation", trigger: { type: "new_contact" }, steps: [{ type: "send", channel: "SMS", mode: "template", text: "Hi {{first_name}}, " }] });
              void state.reload();
              setEditing(a);
            }}
          >
            <Plus /> New automation
          </button>
        </div>
      </div>

      {profileMissing && (
        <Banner tone="warn">
          Messages use your name, business and booking link. <Link to="/settings#profile">Fill in your business profile</Link> so automated texts sound like you.
        </Banner>
      )}
      {appStatus?.crm.mode === "demo" && (
        <Banner tone="info">
          GoHighLevel isn't connected, so automations run but messages are saved here instead of being sent.{appStatus.demoData !== false && <> Use <b>Inbox → Simulate incoming</b> to test the DM and text responders.</>} <Link to="/settings#ghl">Connect GoHighLevel</Link> to go live.
        </Banner>
      )}
      {s?.status.lastError && <Banner tone="bad">The automation engine couldn't read the CRM: {s.status.lastError}</Banner>}

      {s && (
        <div className="kpis" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
          <div className="card kpi2">
            <div className="top"><span className="ichip grad"><Workflow /></span><span className="label">Automations on</span></div>
            <div className="value">{s.automations.filter((a) => a.enabled).length}<span className="faint" style={{ fontSize: 15 }}>/{s.automations.length}</span></div>
          </div>
          <div className="card kpi2">
            <div className="top"><span className="ichip teal"><MessageSquare /></span><span className="label">Sent, last 24h</span></div>
            <div className="value">{s.status.sent24h}</div>
            <div className="foot">limit {s.settings.maxPerDay}/day</div>
          </div>
          <div className="card kpi2">
            <div className="top"><span className="ichip violet"><Clock /></span><span className="label">Contacts in a sequence</span></div>
            <div className="value">{s.status.activeRuns}</div>
            <div className="foot">{s.status.nextRunAt ? `next step ${relTime(s.status.nextRunAt)}` : "nothing scheduled"}</div>
          </div>
          <div className="card kpi2">
            <div className="top"><span className="ichip amber"><Sparkles /></span><span className="label">Handed to you</span></div>
            <div className="value">{s.automations.reduce((a, x) => a + x.stats.handoffs, 0)}</div>
            <div className="foot">tagged needs-human + task</div>
          </div>
        </div>
      )}

      <div className="tabs" style={{ padding: 0 }}>
        {([["automations", "Automations"], ["log", "Activity log"], ["settings", "Safety & settings"]] as const).map(([k, l]) => (
          <button key={k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === "automations" && (
        <>
          {state.loading && !s ? (
            <Card><LoadingRows n={4} /></Card>
          ) : s?.automations.length ? (
            <div className="grid-halves">
              {s.automations.map((a) => {
                const T = TRIGGERS.find((t) => t.type === a.trigger.type) ?? TRIGGERS[0];
                return (
                  <div key={a.id} className="card auto-card lift">
                    <div className="row">
                      <span className={`ichip ${a.enabled ? "grad" : "violet"}`}><T.icon /></span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="name ellipsis">{a.name}</div>
                        <div className="faint small">Updated {relTime(a.updatedAt)}</div>
                      </div>
                      <Toggle on={a.enabled} onChange={(v) => toggle(a, v)} label={`Turn ${a.name} ${a.enabled ? "off" : "on"}`} />
                    </div>
                    {a.description && <div className="small muted">{a.description}</div>}
                    <div className="flow">
                      <span className="node trigger"><T.icon /> {triggerSummary(a.trigger, stages)}</span>
                      {a.steps.map((st) => {
                        const sm = stepSummary(st, stages);
                        return (
                          <span key={st.id} style={{ display: "contents" }}>
                            <span className="arrow">→</span>
                            <span className="node">{sm.icon} {sm.text}</span>
                          </span>
                        );
                      })}
                    </div>
                    <div className="row small" style={{ gap: 14, color: "var(--text-2)" }}>
                      <span><b className="num">{a.stats.enrolled}</b> enrolled</span>
                      <span><b className="num">{a.stats.sent}</b> sent</span>
                      {a.stats.handoffs > 0 && <span><b className="num">{a.stats.handoffs}</b> handed off</span>}
                      {a.stats.failed > 0 && <span style={{ color: "var(--bad)" }}><b className="num">{a.stats.failed}</b> failed</span>}
                      <span className="spacer" />
                      <button className="btn sm ghost" onClick={() => setEditing(a)}><Pencil /> Edit</button>
                      <button className="btn sm ghost icon" aria-label="Delete" onClick={() => setDeleting(a)}><Trash2 /></button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <Card>
              <Empty icon={<Workflow />} title="No automations yet">Start from a recipe below — each one takes about a minute to review and switch on.</Empty>
            </Card>
          )}

          <div>
            <div className="row" style={{ margin: "8px 0 10px" }}>
              <h3 className="display" style={{ margin: 0, fontSize: 19 }}>Recipes</h3>
              <span className="faint small">Proven sequences — add one, tweak the words, switch it on.</span>
            </div>
            <div className="agents-grid">
              {s?.recipes.map((r) => {
                const I = RECIPE_ICON[r.icon] ?? Zap;
                const already = s.automations.some((a) => a.name === r.name);
                return (
                  <button key={r.recipeId} className="recipe" onClick={() => install(r)}>
                    <div className="row">
                      <span className={`ichip ${RECIPE_TINT[r.icon] ?? "rose"}`}><I /></span>
                      <span className="t">{r.name}</span>
                    </div>
                    <span className="d">{r.description}</span>
                    <span className="row small" style={{ gap: 6 }}>
                      <span className="badge accent">{triggerSummary(r.trigger, stages)}</span>
                      {r.needs === "meta" && !appStatus?.has.meta && <span className="badge">needs Meta</span>}
                      {already && <span className="badge good">added</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}

      {tab === "log" && (
        <Card flush>
          {log.loading && !log.data ? (
            <LoadingRows n={8} />
          ) : log.data?.length ? (
            <div className="table-wrap" style={{ maxHeight: "calc(100vh - 360px)" }}>
              <table className="table">
                <thead>
                  <tr><th>When</th><th>Automation</th><th>Contact</th><th>Channel</th><th>Status</th><th>Message</th></tr>
                </thead>
                <tbody>
                  {log.data.map((l) => (
                    <tr key={l.id}>
                      <td className="small muted" style={{ whiteSpace: "nowrap" }} title={new Date(l.at).toLocaleString()}>{relTime(l.at)}</td>
                      <td className="small" style={{ whiteSpace: "nowrap" }}>{l.automationName}</td>
                      <td className="small">{l.contactId ? <Link to={`/inbox/${l.contactId}`}>{l.contactName || "Open"}</Link> : "—"}</td>
                      <td>{l.channel && l.channel !== "—" ? <ChannelBadge channel={l.channel} /> : <span className="faint">—</span>}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <span className={`badge ${STATUS_BADGE[l.status].cls}`}>{STATUS_BADGE[l.status].label}</span>
                        {l.ai && <span className="badge accent" style={{ marginLeft: 4 }}><Sparkles /> AI</span>}
                      </td>
                      <td style={{ maxWidth: 460 }}>
                        <div className="small" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{l.body ? (l.body.length > 220 ? `${l.body.slice(0, 220)}…` : l.body) : <span className="faint">—</span>}</div>
                        {l.reason && <div className="faint small">{l.reason}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon={<Clock />} title="Nothing has run yet">Every message, skip and hand-off is recorded here.</Empty>
          )}
        </Card>
      )}

      {tab === "settings" && s && <EngineSettingsPanel settings={s.settings} onSave={saveSettings} />}

      {editing && (
        <Builder
          automation={editing}
          pipelines={pipelines.data ?? []}
          claude={Boolean(appStatus?.has.claude)}
          onClose={() => setEditing(null)}
          onSaved={() => void state.reload()}
        />
      )}
      {deleting && (
        <ConfirmModal
          title={`Delete “${deleting.name}”?`}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.del(`/api/automations/${deleting.id}`);
            toast("Automation deleted");
            void state.reload();
          }}
        >
          Contacts currently in this sequence stop receiving its messages. The activity log is kept.
        </ConfirmModal>
      )}
    </div>
  );
}

function EngineSettingsPanel({ settings, onSave }: { settings: EngineSettings; onSave: (p: Partial<EngineSettings>) => void }) {
  const [f, setF] = useState(settings);
  const toast = useToast();
  useEffect(() => setF(settings), [settings]);
  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone");
    } catch {
      return [settings.timezone];
    }
  }, [settings.timezone]);
  const hook = `${window.location.origin.replace(":5173", ":4400")}/api/webhooks/ghl/${settings.webhookSecret}`;
  return (
    <div className="grid-halves">
      <Card title="Safety switches">
        <div className="stack">
          <div className="row">
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>Automations running</div>
              <div className="small muted">Master switch. Off pauses every automation instantly; turning it back on won't replay what happened while it was off.</div>
            </div>
            <Toggle on={f.enabled} onChange={(v) => onSave({ enabled: v })} label="Automations running" />
          </div>
          <div className="row">
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>Test mode</div>
              <div className="small muted">Everything runs and is logged — including AI-written messages — but nothing is sent or changed in the CRM.</div>
            </div>
            <Toggle on={f.dryRun} onChange={(v) => onSave({ dryRun: v })} label="Test mode" />
          </div>
          <Banner tone="info">
            Always on: cold prospects (from Find clients or a cold list) are never texted until they agree, either by texting you first or by you tagging them <code>sms-ok</code>; contacts who are DND or tagged <code>opted-out</code> are never messaged; anyone who replies STOP / UNSUBSCRIBE is tagged opted-out and removed from every sequence; Instagram and Messenger DMs only go out within Meta's 24-hour window; the AI hands tricky conversations to you instead of guessing.
          </Banner>
        </div>
      </Card>
      <Card title="Sending window & limits">
        <div className="stack">
          <div className="grid-3">
            <Field label="Send from"><input className="input" type="time" value={f.quietStart} onChange={(e) => setF({ ...f, quietStart: e.target.value })} /></Field>
            <Field label="Until"><input className="input" type="time" value={f.quietEnd} onChange={(e) => setF({ ...f, quietEnd: e.target.value })} /></Field>
            <Field label="Time zone">
              <select className="select" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>
                {zones.map((z) => <option key={z}>{z}</option>)}
              </select>
            </Field>
          </div>
          <div className="small muted">Scheduled messages outside this window wait until it opens. Instant replies to someone who just messaged you still go out right away.</div>
          <div className="grid-2">
            <Field label="Max messages per contact per day"><input className="input" type="number" min={1} max={20} value={f.maxPerContactPerDay} onChange={(e) => setF({ ...f, maxPerContactPerDay: Number(e.target.value) })} /></Field>
            <Field label="Max messages per day (all contacts)"><input className="input" type="number" min={1} max={5000} value={f.maxPerDay} onChange={(e) => setF({ ...f, maxPerDay: Number(e.target.value) })} /></Field>
          </div>
          <div className="row"><span className="spacer" /><button className="btn primary" onClick={() => onSave({ quietStart: f.quietStart, quietEnd: f.quietEnd, timezone: f.timezone, maxPerContactPerDay: f.maxPerContactPerDay, maxPerDay: f.maxPerDay })}>Save</button></div>
        </div>
      </Card>
      <Card title="Instant triggers from GoHighLevel (optional)">
        <div className="stack small">
          <div className="muted">Bloom AI checks GoHighLevel for new contacts, tags, stage changes and messages about every 45 seconds. For instant replies, add a webhook in a GHL workflow:</div>
          <ol className="steps">
            <li>Automation → Workflows → New: trigger <b>Customer Replied</b> (and/or <b>Contact Created</b>).</li>
            <li>Add action <b>Webhook</b> (POST) with this URL:</li>
          </ol>
          <div className="row">
            <input className="input mono" readOnly value={hook} onFocus={(e) => e.currentTarget.select()} />
            <button className="btn" onClick={() => void navigator.clipboard.writeText(hook).then(() => toast("Webhook URL copied"))}><Copy /> Copy</button>
          </div>
          <div className="faint">GoHighLevel must be able to reach this address — when running on your own computer, expose it with a tunnel (e.g. Cloudflare Tunnel) or deploy Bloom AI to a server.</div>
        </div>
      </Card>
    </div>
  );
}

function Builder({ automation, pipelines, claude, onClose, onSaved }: { automation: Automation; pipelines: Pipeline[]; claude: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [a, setA] = useState<Automation>(structuredClone(automation));
  const [busy, setBusy] = useState(false);
  const [previewFor, setPreviewFor] = useState<Contact | null>(null);
  const [preview, setPreview] = useState<{ stepIndex: number; channel: string; subject?: string; body: string; ai: boolean; note?: string }[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [focus, setFocus] = useState<{ step: number; field: "text" | "subject" | "title" } | null>(null);
  const allStages = pipelines.flatMap((p) => p.stages.map((s) => ({ ...s, pipeline: p.name })));

  const setTrigger = (t: Partial<Trigger>) => setA({ ...a, trigger: { ...a.trigger, ...t } });
  const setStep = (i: number, patch: Partial<Step>) => setA({ ...a, steps: a.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const move = (i: number, d: -1 | 1) => {
    const steps = [...a.steps];
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    [steps[i], steps[j]] = [steps[j], steps[i]];
    setA({ ...a, steps });
  };
  const add = (type: StepType) => {
    const base: Step =
      type === "wait"
        ? { id: newId(), type, amount: 1, unit: "days" }
        : type === "send"
          ? { id: newId(), type, channel: a.trigger.type === "inbound_message" ? "reply" : "SMS", mode: claude ? "ai" : "template", text: "", instructions: "" }
          : type === "create_task"
            ? { id: newId(), type, title: "Follow up with {{first_name}}", dueInDays: 0 }
            : type === "move_stage"
              ? { id: newId(), type, stageId: allStages[0]?.id ?? "" }
              : { id: newId(), type, tag: "" };
    setA({ ...a, steps: [...a.steps, base] });
  };
  const insertMerge = (k: string) => {
    if (!focus) return;
    const s = a.steps[focus.step];
    const cur = (s[focus.field] as string | undefined) ?? "";
    setStep(focus.step, { [focus.field]: `${cur}{{${k}}}` });
  };

  const save = async (enable?: boolean) => {
    setBusy(true);
    try {
      await api.put(`/api/automations/${a.id}`, { name: a.name, description: a.description, trigger: a.trigger, steps: a.steps, exitOnReply: a.exitOnReply, ...(enable !== undefined ? { enabled: enable } : {}) });
      toast(enable ? `“${a.name}” is live` : "Automation saved");
      onSaved();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not save", "bad");
    } finally {
      setBusy(false);
    }
  };

  const runPreview = async (c: Contact) => {
    setPreviewFor(c);
    setPreviewing(true);
    setPreview(null);
    try {
      setPreview(await api.post(`/api/automations/${a.id}/preview`, { contactId: c.id, draft: { trigger: a.trigger, steps: a.steps } }));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Preview failed", "bad");
    } finally {
      setPreviewing(false);
    }
  };

  const T = TRIGGERS.find((t) => t.type === a.trigger.type) ?? TRIGGERS[0];

  return (
    <Modal
      wide
      title={<input className="input display" style={{ fontSize: 18, height: 38, border: "1px solid transparent", background: "transparent", padding: "0 6px", width: 420 }} value={a.name} onChange={(e) => setA({ ...a, name: e.target.value })} aria-label="Automation name" />}
      onClose={onClose}
      footer={
        <>
          <label className="row small" style={{ marginRight: "auto" }}>
            <input type="checkbox" checked={a.exitOnReply} onChange={(e) => setA({ ...a, exitOnReply: e.target.checked })} /> Stop the sequence when the contact replies
          </label>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn" onClick={() => save()} disabled={busy}>Save</button>
          {!automation.enabled && <button className="btn primary" onClick={() => save(true)} disabled={busy}><Zap /> Save & turn on</button>}
        </>
      }
    >
      <Field label="Description"><input className="input" value={a.description} onChange={(e) => setA({ ...a, description: e.target.value })} placeholder="What this automation does" /></Field>

      <div className="card" style={{ padding: 14, background: "var(--accent-soft)", borderColor: "transparent" }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <span className="ichip grad"><T.icon /></span>
          <b>When…</b>
          <select className="select" style={{ maxWidth: 260 }} value={a.trigger.type} onChange={(e) => setA({ ...a, trigger: { type: e.target.value as TriggerType, ...(e.target.value === "deal_idle" ? { days: 14 } : e.target.value === "inbound_message" ? { channel: "any" } : {}) } })}>
            {TRIGGERS.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
          </select>
          <span className="small muted">{T.hint}</span>
        </div>
        <div className="grid-3">
          {a.trigger.type === "tag_added" && <Field label="Tag"><input className="input" value={a.trigger.tag ?? ""} onChange={(e) => setTrigger({ tag: e.target.value })} placeholder="e.g. hot" /></Field>}
          {a.trigger.type === "stage_changed" && (
            <Field label="Stage">
              <select className="select" value={a.trigger.stageId ?? ""} onChange={(e) => setTrigger({ stageId: e.target.value })}>
                <option value="">Pick a stage…</option>
                {pipelines.map((p) => (
                  <optgroup key={p.id} label={p.name}>{p.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>
                ))}
              </select>
            </Field>
          )}
          {a.trigger.type === "deal_idle" && <Field label="Days without a stage change"><input className="input" type="number" min={1} value={a.trigger.days ?? 14} onChange={(e) => setTrigger({ days: Number(e.target.value) })} /></Field>}
          {a.trigger.type === "inbound_message" && (
            <>
              <Field label="Channel">
                <select className="select" value={a.trigger.channel ?? "any"} onChange={(e) => setTrigger({ channel: e.target.value })}>
                  <option value="any">Any channel</option>
                  <option value="DM">Instagram + Messenger DMs</option>
                  <option value="IG">Instagram only</option>
                  <option value="FB">Messenger only</option>
                  <option value="SMS">SMS</option>
                  <option value="WhatsApp">WhatsApp</option>
                  <option value="Email">Email</option>
                </select>
              </Field>
              <Field label="Only if it contains (optional)" hint="Comma separated, any match"><input className="input" value={a.trigger.keyword ?? ""} onChange={(e) => setTrigger({ keyword: e.target.value })} placeholder="price, cost, quote" /></Field>
            </>
          )}
          {a.trigger.type === "call_logged" && (
            <Field label="Outcome">
              <select className="select" value={a.trigger.outcome ?? "any"} onChange={(e) => setTrigger({ outcome: e.target.value })}>
                <option value="any">Any outcome</option>
                {["connected", "booked", "callback", "voicemail", "no_answer", "not_interested"].map((o) => <option key={o} value={o}>{o.replace(/_/g, " ")}</option>)}
              </select>
            </Field>
          )}
          {a.trigger.type === "new_contact" && (
            <label className="row small" style={{ gridColumn: "1 / -1", alignItems: "flex-start" }}>
              <input type="checkbox" checked={Boolean(a.trigger.includeProspects)} onChange={(e) => setTrigger({ includeProspects: e.target.checked })} style={{ marginTop: 3 }} />
              <span>Also include cold prospects (added from Find clients or a cold list). They still won't get texts until they agree, so use email and call-task steps for them.</span>
            </label>
          )}
          {a.trigger.type === "meta_lead" && <Field label="Form name contains (optional)"><input className="input" value={a.trigger.formName ?? ""} onChange={(e) => setTrigger({ formName: e.target.value })} /></Field>}
        </div>
      </div>

      <div className="row" style={{ marginTop: 4 }}>
        <b>Then…</b>
        <span className="spacer" />
        {focus && (
          <div className="merge-chips" aria-label="Insert merge field">
            {MERGE.map((m) => <button key={m} onClick={() => insertMerge(m)}>{`{{${m}}}`}</button>)}
          </div>
        )}
      </div>
      <div className="steps-list">
        {a.steps.map((s, i) => (
          <div key={s.id}>
            {i > 0 && <div className="step-connector" />}
            <div className="step-card">
              <span className={`step-num ${s.type === "send" ? "send" : ""}`}>{i + 1}</span>
              <div className="stack" style={{ gap: 8, minWidth: 0 }}>
                {s.type === "wait" && (
                  <div className="row">
                    <Hourglass size={15} className="faint" /> Wait
                    <input className="input" type="number" min={1} style={{ width: 80 }} value={s.amount ?? 1} onChange={(e) => setStep(i, { amount: Number(e.target.value) })} />
                    <select className="select" style={{ width: 120 }} value={s.unit ?? "days"} onChange={(e) => setStep(i, { unit: e.target.value as Step["unit"] })}>
                      <option value="minutes">minutes</option>
                      <option value="hours">hours</option>
                      <option value="days">days</option>
                    </select>
                  </div>
                )}
                {s.type === "send" && (
                  <>
                    <div className="row wrap">
                      <span style={{ fontWeight: 600 }}>Send</span>
                      <select className="select" style={{ width: 210 }} value={s.channel ?? "SMS"} onChange={(e) => setStep(i, { channel: e.target.value })}>
                        {a.trigger.type === "inbound_message" && <option value="reply">Reply on the same channel</option>}
                        <option value="SMS">SMS text</option>
                        <option value="IG">Instagram DM</option>
                        <option value="FB">Messenger DM</option>
                        <option value="WhatsApp">WhatsApp</option>
                        <option value="Email">Email</option>
                      </select>
                      <div className="btn-group">
                        <button className={`btn sm ${s.mode !== "ai" ? "on" : ""}`} onClick={() => setStep(i, { mode: "template" })}>Template</button>
                        <button className={`btn sm ${s.mode === "ai" ? "on" : ""}`} onClick={() => setStep(i, { mode: "ai" })}><Sparkles /> AI writes it</button>
                      </div>
                    </div>
                    {(s.channel === "IG" || s.channel === "FB") && <div className="faint small">Meta only allows this within 24 hours of the person's last DM — outside that window the step is skipped and logged.</div>}
                    {s.mode === "ai" && (
                      <>
                        {!claude && <Banner tone="warn"><Link to="/settings#claude">Connect Claude</Link> for AI-written messages. Until then the fallback text below is sent.</Banner>}
                        <div className="grid-2">
                          <Field label="Tell the AI what this message should do">
                            <textarea className="textarea" rows={3} value={s.instructions ?? ""} onChange={(e) => setStep(i, { instructions: e.target.value })} placeholder="e.g. Answer their question, ask about their timeline, and offer the booking link." />
                          </Field>
                          <Field label="Written by">
                            <select className="select" value={s.agentSlug ?? "sales-outreach"} onChange={(e) => setStep(i, { agentSlug: e.target.value })}>
                              {AGENTS.map((ag) => <option key={ag.slug} value={ag.slug}>{ag.label}</option>)}
                            </select>
                          </Field>
                        </div>
                      </>
                    )}
                    {s.channel === "Email" && <Field label="Subject"><input className="input" value={s.subject ?? ""} onFocus={() => setFocus({ step: i, field: "subject" })} onChange={(e) => setStep(i, { subject: e.target.value })} /></Field>}
                    <Field label={s.mode === "ai" ? "Fallback text (used if the AI is unavailable)" : "Message"} hint={s.channel === "SMS" && s.text ? `${s.text.length} characters` : undefined}>
                      <textarea className="textarea" rows={s.channel === "Email" ? 5 : 3} value={s.text ?? ""} onFocus={() => setFocus({ step: i, field: "text" })} onChange={(e) => setStep(i, { text: e.target.value })} />
                    </Field>
                  </>
                )}
                {(s.type === "add_tag" || s.type === "remove_tag") && (
                  <div className="row">
                    <Tag size={15} className="faint" />
                    <select className="select" style={{ width: 140 }} value={s.type} onChange={(e) => setStep(i, { type: e.target.value as StepType })}>
                      <option value="add_tag">Add tag</option>
                      <option value="remove_tag">Remove tag</option>
                    </select>
                    <input className="input" style={{ maxWidth: 220 }} value={s.tag ?? ""} onChange={(e) => setStep(i, { tag: e.target.value })} placeholder="tag" />
                  </div>
                )}
                {s.type === "create_task" && (
                  <div className="row wrap">
                    <CheckSquare size={15} className="faint" /> Task
                    <input className="input" style={{ flex: 1, minWidth: 220 }} value={s.title ?? ""} onFocus={() => setFocus({ step: i, field: "title" })} onChange={(e) => setStep(i, { title: e.target.value })} />
                    due in
                    <input className="input" type="number" min={0} style={{ width: 70 }} value={s.dueInDays ?? 0} onChange={(e) => setStep(i, { dueInDays: Number(e.target.value) })} /> days
                  </div>
                )}
                {s.type === "move_stage" && (
                  <div className="row">
                    <Columns3 size={15} className="faint" /> Move their open deal to
                    <select className="select" style={{ maxWidth: 280 }} value={s.stageId ?? ""} onChange={(e) => setStep(i, { stageId: e.target.value })}>
                      {pipelines.map((p) => (
                        <optgroup key={p.id} label={p.name}>{p.stages.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}</optgroup>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              <div className="row" style={{ gap: 2 }}>
                <button className="btn sm ghost icon" aria-label="Move up" onClick={() => move(i, -1)} disabled={i === 0}><ArrowUp /></button>
                <button className="btn sm ghost icon" aria-label="Move down" onClick={() => move(i, 1)} disabled={i === a.steps.length - 1}><ArrowDown /></button>
                <button className="btn sm ghost icon" aria-label="Remove step" onClick={() => setA({ ...a, steps: a.steps.filter((_, j) => j !== i) })}><Trash2 /></button>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="row wrap">
        <span className="small muted">Add step:</span>
        <button className="btn sm" onClick={() => add("send")}><MessageSquare /> Send message</button>
        <button className="btn sm" onClick={() => add("wait")}><Hourglass /> Wait</button>
        <button className="btn sm" onClick={() => add("add_tag")}><Tag /> Tag</button>
        <button className="btn sm" onClick={() => add("create_task")}><CheckSquare /> Task</button>
        <button className="btn sm" onClick={() => add("move_stage")}><Columns3 /> Move deal</button>
      </div>

      <div className="card" style={{ padding: 14 }}>
        <div className="row" style={{ marginBottom: 8 }}>
          <Eye size={15} /> <b>Preview with a real contact</b>
          <span className="faint small">Shows exactly what would be sent. Nothing is sent.</span>
        </div>
        <div className="grid-2" style={{ alignItems: "start" }}>
          <ContactPicker autoFocus={false} value={previewFor} onChange={(c) => (c ? void runPreview(c) : (setPreviewFor(null), setPreview(null)))} />
          <div className="stack" style={{ gap: 8 }}>
            {previewing && <LoadingRows n={2} />}
            {preview?.map((p) => (
              <div key={p.stepIndex} className="card" style={{ padding: 10 }}>
                <div className="row small" style={{ marginBottom: 4 }}>
                  <span className="faint">Step {p.stepIndex + 1}</span> <ChannelBadge channel={p.channel} /> {p.ai && <span className="badge accent"><Sparkles /> AI</span>}
                </div>
                {p.subject && <div className="small"><b>{p.subject}</b></div>}
                <div className="small" style={{ whiteSpace: "pre-wrap" }}>{p.body || <span className="faint">—</span>}</div>
                {p.note && <div className="faint small" style={{ marginTop: 4 }}>{p.note}</div>}
              </div>
            ))}
            {preview && !preview.length && <div className="faint small">This automation has no message steps.</div>}
          </div>
        </div>
      </div>
      {automation.enabled && <div className="faint small"><FlaskConical size={12} /> Changes apply to the next step each contact reaches.</div>}
    </Modal>
  );
}
