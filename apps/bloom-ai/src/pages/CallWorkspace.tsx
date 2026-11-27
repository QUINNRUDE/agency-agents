import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, Mail, MessageSquare, Phone, PhoneOff, Play, Sparkles } from "lucide-react";
import { api, type CallLog, type ContactBundle, type Opportunity } from "../lib/api.ts";
import { duration, money, OUTCOMES, outcomeLabel, outcomeTone, phoneDisplay, relTime } from "../lib/format.ts";
import { AiPanel } from "../components/AiPanel.tsx";
import { ComposeModal } from "../components/Compose.tsx";
import { Avatar, Card, ErrorState, Field, LoadingRows, useAsync, useToast } from "../components/ui.tsx";
import { useApp } from "../App.tsx";

// Discovery flow distilled from the Discovery Coach agent (sales/sales-discovery-coach.md).
const DISCOVERY = [
  "How are new customers finding you today?",
  "Roughly how many new leads or calls come in each month?",
  "What happens to a lead after it comes in? Who follows up, and how fast?",
  "What's an average customer worth to you over a year?",
  "What have you tried for marketing before? What worked, what didn't?",
  "If this goes well, what does the business look like in 6 months?",
  "What's stopping you from getting there on your own?",
  "Who else is involved in a decision like this?",
  "Is there a budget set aside for growth this quarter?",
];

const OBJECTIONS: { label: string; reply: string }[] = [
  { label: "Too expensive", reply: "Totally fair — compared to what? If one extra customer a month is worth more than the fee, is the real question whether it'll actually bring those customers in?" },
  { label: "Already have someone", reply: "Good — then you know the value. Quick question: do you know your cost per lead right now? If not, a second set of eyes costs nothing and you'll leave with a benchmark." },
  { label: "Send me an email", reply: "Happy to. So I send something actually useful — what's the one thing you'd want it to answer? And can we pencil 15 minutes Thursday to go over it?" },
  { label: "Not a good time", reply: "Understood, I'll be quick or call back — which is better? When's a time you're usually at your desk?" },
  { label: "Talk to my partner", reply: "Makes sense. What do you think their first question will be? Let's get them on a short call together so you don't have to relay it." },
  { label: "Tried it, didn't work", reply: "That's common — usually it's tracking or follow-up, not the ads. What happened last time? If we can't show you where it broke, I won't pitch you." },
  { label: "We're busy enough", reply: "Great problem. Is it the right kind of work at the right price? Most owners at capacity use this to raise prices or pick better jobs, not just get more." },
];

const FOLLOW_UPS = [
  { label: "Tomorrow", days: 1 },
  { label: "In 3 days", days: 3 },
  { label: "Next week", days: 7 },
  { label: "In 2 weeks", days: 14 },
];

function isoDay(days: number) {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setHours(9, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

export function CallWorkspace() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const inSession = params.get("session") === "1";
  const nav = useNavigate();
  const toast = useToast();
  const { status } = useApp();
  const { data, error, loading, reload } = useAsync(() => api.get<ContactBundle>(`/api/contacts/${id}`), [id]);

  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [notes, setNotes] = useState("");
  const [outcome, setOutcome] = useState<string>("");
  const [nextStep, setNextStep] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [stageId, setStageId] = useState("");
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [coachTab, setCoachTab] = useState<"prep" | "script" | "objection" | "summary">("prep");
  const [objectionRun, setObjectionRun] = useState<{ id: string; extra: string; nonce: number } | null>(null);
  const [localReply, setLocalReply] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [logged, setLogged] = useState<CallLog | null>(null);
  const [compose, setCompose] = useState<null | { channel: "SMS" | "Email"; subject?: string; body?: string }>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);

  // Reset when moving to the next contact in a session.
  useEffect(() => {
    setStartedAt(null);
    setEndedAt(null);
    setOutcome("");
    setNextStep("");
    setFollowUp("");
    setStageId("");
    setChecked(new Set());
    setLogged(null);
    setLocalReply(null);
    try {
      setNotes(sessionStorage.getItem(`bloom-notes-${id}`) ?? "");
    } catch {
      setNotes("");
    }
  }, [id]);

  useEffect(() => {
    try {
      if (notes) sessionStorage.setItem(`bloom-notes-${id}`, notes);
    } catch {
      /* ignore */
    }
  }, [notes, id]);

  useEffect(() => {
    if (!startedAt || endedAt) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [startedAt, endedAt]);

  const elapsed = startedAt ? Math.floor(((endedAt ?? Date.now()) - startedAt) / 1000) : 0;
  void tick;

  const session = useMemo<string[]>(() => {
    if (!inSession) return [];
    try {
      return JSON.parse(sessionStorage.getItem("bloom-session") ?? "[]");
    } catch {
      return [];
    }
  }, [inSession]);
  const pos = session.indexOf(id);
  const nextId = pos >= 0 ? session[pos + 1] : undefined;

  const opp: Opportunity | undefined = data?.opportunities.filter((o) => o.status === "open").sort((a, b) => b.value - a.value)[0];
  const pipeline = data?.pipelines.find((p) => p.id === opp?.pipelineId);
  const stage = pipeline?.stages.find((s) => s.id === opp?.stageId);

  // Suggest a stage move from the outcome.
  useEffect(() => {
    if (!pipeline || !opp) return;
    const find = (re: RegExp) => pipeline.stages.find((s) => re.test(s.name))?.id;
    if (outcome === "booked") setStageId(find(/discovery|meeting|booked|appointment/i) ?? "");
    else if (outcome === "connected" && stage && stage.position === 0) setStageId(find(/contacted|engaged|qualified/i) ?? "");
    else setStageId("");
    if (outcome === "callback" || outcome === "voicemail" || outcome === "no_answer") setFollowUp((f) => f || isoDay(outcome === "callback" ? 1 : 2));
  }, [outcome, pipeline, opp, stage]);

  if (error) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;
  if (loading && !data) return <div className="page"><Card><LoadingRows n={10} /></Card></div>;
  if (!data) return null;
  const c = data.contact;

  const dial = () => {
    setStartedAt(Date.now());
    setEndedAt(null);
    if (c.phone) window.location.href = `tel:${c.phone.replace(/[^\d+]/g, "")}`;
    setTimeout(() => notesRef.current?.focus(), 50);
  };

  const save = async () => {
    if (!outcome) {
      toast("Pick an outcome first", "bad");
      return;
    }
    setSaving(true);
    try {
      const checkedQs = [...checked].map((i) => `✓ ${DISCOVERY[i]}`).join("\n");
      const r = await api.post<{ call: CallLog; warnings: string[] }>("/api/calls", {
        contactId: c.id,
        outcome,
        durationSec: elapsed,
        notes: [notes.trim(), checkedQs && `\nCovered:\n${checkedQs}`].filter(Boolean).join("\n"),
        nextStep,
        followUpDate: followUp ? new Date(`${followUp}T09:00:00`).toISOString() : null,
        startedAt: startedAt ? new Date(startedAt).toISOString() : undefined,
        opportunityId: stageId && opp ? opp.id : undefined,
        stageId: stageId || undefined,
      });
      setLogged(r.call);
      r.warnings.forEach((w) => toast(w, "bad"));
      toast(r.call.syncedToCrm ? "Call logged and synced to the CRM" : "Call logged locally");
      try {
        sessionStorage.removeItem(`bloom-notes-${id}`);
      } catch {
        /* ignore */
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not log call", "bad");
    } finally {
      setSaving(false);
    }
  };

  const askObjection = (text: string) => {
    setCoachTab("objection");
    if (status?.has.claude) setObjectionRun({ id: "objection", extra: text, nonce: Date.now() });
    else setLocalReply(OBJECTIONS.find((o) => o.label === text)?.reply ?? null);
  };

  const lastNote = data.notes.find((n) => !/^Call — /.test(n.body));

  return (
    <div className="page" style={{ maxWidth: 1600 }}>
      <div className="row wrap">
        <button className="btn ghost sm" onClick={() => nav("/calls")}><ArrowLeft /> Queue</button>
        {inSession && pos >= 0 && <span className="badge accent">Session · {pos + 1} of {session.length}</span>}
        <span className="spacer" />
        <Link className="btn sm ghost" to={`/clients/${c.id}`}>Open full profile</Link>
        {nextId && <button className="btn sm" onClick={() => nav(`/calls/${nextId}?session=1`)}>Skip <ArrowRight /></button>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 320px) minmax(0, 1fr) minmax(320px, 420px)", gap: 16, alignItems: "start" }} className="call-grid">
        {/* Left: who you're calling */}
        <div className="stack" style={{ gap: 16 }}>
          <Card>
            <div className="stack" style={{ gap: 10 }}>
              <div className="row">
                <Avatar name={c.name} size="lg" />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 16 }}>{c.name}</div>
                  <div className="muted small ellipsis">{c.companyName || "—"}</div>
                </div>
              </div>
              <div className="num" style={{ fontSize: 18 }}>{c.phone ? phoneDisplay(c.phone) : "No phone on file"}</div>
              <div className="small muted">{[c.city, c.state].filter(Boolean).join(", ")}{c.website && <> · <a href={c.website} target="_blank" rel="noreferrer">website</a></>}</div>
              {opp && (
                <div className="row wrap small">
                  <span className="badge">{stage?.name}</span>
                  <span className="num">{money(opp.value)}</span>
                  <span className="faint">· in stage {relTime(opp.lastStageChangeAt ?? opp.updatedAt)}</span>
                </div>
              )}
              <div className="row wrap" style={{ gap: 4 }}>{c.tags.map((t) => <span className="tag" key={t}>{t}</span>)}</div>
              <div className="row">
                <button className="btn sm" onClick={() => setCompose({ channel: "SMS" })} disabled={!c.phone}><MessageSquare /> Text</button>
                <button className="btn sm" onClick={() => setCompose({ channel: "Email" })} disabled={!c.email}><Mail /> Email</button>
              </div>
            </div>
          </Card>
          {lastNote && (
            <Card title="Latest note" sub={relTime(lastNote.dateAdded)}>
              <div className="small" style={{ whiteSpace: "pre-wrap", maxHeight: 160, overflow: "auto" }}>{lastNote.body}</div>
            </Card>
          )}
          <Card title="Previous calls" flush>
            {data.calls.length ? (
              <div className="list">
                {data.calls.slice(0, 4).map((cl) => (
                  <div className="list-item" key={cl.id} style={{ alignItems: "flex-start" }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="row"><span className={`badge ${outcomeTone(cl.outcome)}`}>{outcomeLabel(cl.outcome)}</span><span className="faint small">{relTime(cl.startedAt)}</span></div>
                      {cl.notes && <div className="s" style={{ marginTop: 4 }}>{cl.notes.slice(0, 140)}</div>}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="faint small" style={{ padding: "0 16px 14px" }}>First call with this contact.</div>
            )}
          </Card>
        </div>

        {/* Center: the call */}
        <div className="stack" style={{ gap: 16 }}>
          <section className="card">
            <div className="call-bar">
              {startedAt && !endedAt && <span className="live-dot" aria-label="On call" />}
              <span className="timer">{duration(elapsed)}</span>
              <span className="muted small">{!startedAt ? "Ready to dial" : endedAt ? "Call ended" : "On call"}</span>
              <span className="spacer" />
              {!startedAt || endedAt ? (
                <>
                  {endedAt && <button className="btn" onClick={() => setEndedAt(null)}><Play /> Resume timer</button>}
                  <button className="btn primary lg" onClick={dial} disabled={!c.phone}><Phone /> {endedAt ? "Redial" : "Dial"}</button>
                </>
              ) : (
                <button className="btn lg" style={{ background: "var(--bad)", borderColor: "var(--bad)", color: "#fff" }} onClick={() => setEndedAt(Date.now())}><PhoneOff /> End call</button>
              )}
            </div>
            <div style={{ padding: "0 16px 16px" }} className="stack">
              <div className="faint small">Dial opens your phone app (GoHighLevel's LC Phone, softphone or mobile) and starts the timer. Notes save as you type.</div>
              <Field label="Call notes">
                <textarea ref={notesRef} className="textarea" rows={9} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What did you learn? Pain points, budget, timeline, decision makers…" />
              </Field>
            </div>
          </section>

          <Card title="Wrap up">
            <div className="stack">
              <div className="outcomes">
                {OUTCOMES.map((o) => (
                  <button key={o.id} className={`outcome ${outcome === o.id ? "on" : ""}`} onClick={() => setOutcome(o.id)}>{o.label}</button>
                ))}
              </div>
              <div className="grid-2">
                <Field label="Next step">
                  <input className="input" value={nextStep} onChange={(e) => setNextStep(e.target.value)} placeholder="e.g. Send case study, discovery call Thu 2pm" />
                </Field>
                <Field label="Follow-up date" hint="Creates a task in GoHighLevel">
                  <input className="input" type="date" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
                </Field>
              </div>
              <div className="chips">
                {FOLLOW_UPS.map((f) => (
                  <button key={f.label} className={`chip ${followUp === isoDay(f.days) ? "on" : ""}`} onClick={() => setFollowUp(isoDay(f.days))}>{f.label}</button>
                ))}
                {followUp && <button className="chip" onClick={() => setFollowUp("")}>No follow-up</button>}
              </div>
              {opp && pipeline && (
                <Field label={`Move “${opp.name}”`}>
                  <select className="select" value={stageId} onChange={(e) => setStageId(e.target.value)}>
                    <option value="">Keep in {stage?.name}</option>
                    {pipeline.stages.filter((s) => s.id !== opp.stageId).map((s) => <option key={s.id} value={s.id}>Move to {s.name}</option>)}
                  </select>
                </Field>
              )}
              <div className="row">
                {logged ? (
                  <>
                    <span className="status-line good">Logged · {outcomeLabel(logged.outcome)} · {duration(logged.durationSec)}</span>
                    <span className="spacer" />
                    <button className="btn" onClick={() => (setCoachTab("summary"))}><Sparkles /> Draft follow-up</button>
                    {nextId ? (
                      <button className="btn primary" onClick={() => nav(`/calls/${nextId}?session=1`)}>Next call <ArrowRight /></button>
                    ) : (
                      <button className="btn primary" onClick={() => nav("/calls")}>Back to queue</button>
                    )}
                  </>
                ) : (
                  <>
                    <span className="faint small">Saves a note on the contact{followUp ? ", creates a follow-up task" : ""}{stageId ? ", and moves the deal" : ""}.</span>
                    <span className="spacer" />
                    <button className="btn primary" onClick={save} disabled={saving || !outcome}>{saving ? "Saving…" : "Log call"}</button>
                  </>
                )}
              </div>
            </div>
          </Card>
        </div>

        {/* Right: coaching */}
        <div className="stack" style={{ gap: 16 }}>
          <section className="card">
            <div className="tabs" style={{ padding: "0 8px" }}>
              {([["prep", "Prep"], ["script", "Script"], ["objection", "Objections"], ["summary", "After"]] as const).map(([k, l]) => (
                <button key={k} className={`tab ${coachTab === k ? "on" : ""}`} onClick={() => setCoachTab(k)}>{l}</button>
              ))}
            </div>
            <div className="card-body">
              {coachTab === "prep" && (
                <div className="stack">
                  <AiPanel contactId={c.id} playbookIds={["call-prep"]} compact />
                  <div>
                    <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>Discovery checklist</div>
                    <div className="checklist">
                      {DISCOVERY.map((q, i) => (
                        <label key={i} className={`check ${checked.has(i) ? "done" : ""}`}>
                          <input type="checkbox" checked={checked.has(i)} onChange={() => setChecked((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; })} />
                          <span>{q}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              {coachTab === "script" && <AiPanel contactId={c.id} playbookIds={["cold-call-script"]} compact />}
              {coachTab === "objection" && (
                <div className="stack">
                  <div className="chips">
                    {OBJECTIONS.map((o) => <button key={o.label} className="chip" onClick={() => askObjection(o.label)}>{o.label}</button>)}
                  </div>
                  {status?.has.claude ? (
                    <AiPanel contactId={c.id} playbookIds={["objection"]} compact autoRun={objectionRun} />
                  ) : (
                    <>
                      {localReply && <div className="card" style={{ padding: 12, background: "var(--surface-2)" }}><div className="small">{localReply}</div></div>}
                      <div className="faint small">These are starter responses. <Link to="/settings#claude">Connect Claude</Link> for answers tailored to this client and the exact words they used.</div>
                    </>
                  )}
                </div>
              )}
              {coachTab === "summary" && (
                <div className="stack">
                  <AiPanel
                    contactId={c.id}
                    playbookIds={["call-summary", "follow-up"]}
                    defaultId={logged ? "follow-up" : "call-summary"}
                    compact
                    seedExtra={notes}
                    onSaved={reload}
                    onSendFollowUp={(d) => setCompose(c.email && d.email ? { channel: "Email", subject: d.subject, body: d.email } : { channel: "SMS", body: d.sms })}
                  />
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
      {compose && <ComposeModal contact={c} initial={compose} onClose={() => setCompose(null)} onSent={reload} />}
      <style>{`@media (max-width: 1280px) { .call-grid { grid-template-columns: minmax(0,1fr) minmax(320px, 400px) !important; } .call-grid > :first-child { grid-column: 1 / -1; } } @media (max-width: 900px) { .call-grid { grid-template-columns: minmax(0,1fr) !important; } }`}</style>
    </div>
  );
}
