import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Phone, PhoneCall, PhoneForwarded } from "lucide-react";
import { api, type CallLog, type QueueItem } from "../lib/api.ts";
import { duration, OUTCOMES, outcomeLabel, outcomeTone, pct, phoneDisplay, relTime } from "../lib/format.ts";
import { Avatar, Card, Empty, ErrorState, LoadingRows, useAsync } from "../components/ui.tsx";
import { BarList } from "../components/charts.tsx";

export function Calls() {
  const nav = useNavigate();
  const queue = useAsync(() => api.get<QueueItem[]>("/api/calls/queue"));
  const calls = useAsync(() => api.get<CallLog[]>("/api/calls"));
  const [range, setRange] = useState<"today" | "week" | "month">("week");
  const [outcome, setOutcome] = useState("");

  const inRange = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const from = range === "today" ? start.getTime() : Date.now() - (range === "week" ? 7 : 30) * 86_400_000;
    return (calls.data ?? []).filter((c) => new Date(c.startedAt).getTime() >= from);
  }, [calls.data, range]);

  const connected = inRange.filter((c) => ["connected", "booked", "callback", "not_interested"].includes(c.outcome));
  const talk = connected.reduce((s, c) => s + c.durationSec, 0);
  const breakdown = OUTCOMES.map((o) => ({ label: o.label, value: inRange.filter((c) => c.outcome === o.id).length })).filter((x) => x.value > 0);
  const history = (calls.data ?? []).filter((c) => !outcome || c.outcome === outcome);

  const startSession = () => {
    const ids = (queue.data ?? []).map((q) => q.contact.id);
    if (!ids.length) return;
    try {
      sessionStorage.setItem("bloom-session", JSON.stringify(ids));
    } catch {
      /* storage unavailable: session still works for the first call */
    }
    nav(`/calls/${ids[0]}?session=1`);
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Calls</h2>
          <p>A prioritised call queue, a live call workspace with agent coaching, and outcomes that write back to GoHighLevel.</p>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={startSession} disabled={!queue.data?.length}>
            <PhoneForwarded /> Start calling session{queue.data?.length ? ` (${queue.data.length})` : ""}
          </button>
        </div>
      </div>

      <div className="row">
        <div className="btn-group">
          {(["today", "week", "month"] as const).map((r) => (
            <button key={r} className={`btn sm ${range === r ? "on" : ""}`} onClick={() => setRange(r)}>
              {r === "today" ? "Today" : r === "week" ? "7 days" : "30 days"}
            </button>
          ))}
        </div>
      </div>
      <div className="kpis">
        <div className="card kpi"><div className="kpi-label">Dials</div><div className="kpi-value">{inRange.length}</div><div className="kpi-foot">logged calls</div></div>
        <div className="card kpi"><div className="kpi-label">Connect rate</div><div className="kpi-value">{pct(inRange.length ? connected.length / inRange.length : null)}</div><div className="kpi-foot">{connected.length} conversations</div></div>
        <div className="card kpi"><div className="kpi-label">Meetings booked</div><div className="kpi-value">{inRange.filter((c) => c.outcome === "booked").length}</div><div className="kpi-foot">{pct(connected.length ? inRange.filter((c) => c.outcome === "booked").length / connected.length : null)} of conversations</div></div>
        <div className="card kpi"><div className="kpi-label">Talk time</div><div className="kpi-value">{duration(talk)}</div><div className="kpi-foot">avg {connected.length ? duration(talk / connected.length) : "0:00"} per conversation</div></div>
        <div className="card kpi"><div className="kpi-label">Follow-ups set</div><div className="kpi-value">{inRange.filter((c) => c.followUpDate).length}</div><div className="kpi-foot">tasks created in CRM</div></div>
      </div>

      <div className="split-r">
        <Card title="Call queue" sub="Ranked by follow-ups due, deal stage, lead age and heat" flush>
          {queue.error && <div style={{ padding: 16 }}><ErrorState error={queue.error} onRetry={queue.reload} /></div>}
          {queue.loading && !queue.data ? (
            <LoadingRows n={8} />
          ) : queue.data?.length ? (
            <div className="list" style={{ maxHeight: 620, overflowY: "auto" }}>
              {queue.data.map((q, i) => (
                <div className="list-item clickable" key={q.contact.id} onClick={() => nav(`/calls/${q.contact.id}`)}>
                  <span className="faint num small" style={{ width: 20 }}>{i + 1}</span>
                  <Avatar name={q.contact.name} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="t ellipsis">{q.contact.name}{q.contact.companyName && q.contact.companyName !== q.contact.name && <span className="faint" style={{ fontWeight: 400 }}> · {q.contact.companyName}</span>}</div>
                    <div className="row" style={{ gap: 4, marginTop: 3, flexWrap: "wrap" }}>
                      {q.reasons.map((r) => <span key={r} className={`badge ${r === "Follow-up due" ? "warn" : r === "Hot" ? "bad" : r.startsWith("New lead") ? "accent" : ""}`}>{r}</span>)}
                    </div>
                  </div>
                  <span className="num small muted" style={{ whiteSpace: "nowrap" }}>{phoneDisplay(q.contact.phone)}</span>
                  {q.lastCall && <span className="faint small" style={{ width: 70, textAlign: "right" }}>{relTime(q.lastCall.startedAt)}</span>}
                  <button className="btn sm" onClick={(e) => (e.stopPropagation(), nav(`/calls/${q.contact.id}`))}><Phone /> Call</button>
                </div>
              ))}
            </div>
          ) : (
            <Empty icon={<PhoneCall />} title="Queue is clear">Everyone due a call has been called today.</Empty>
          )}
        </Card>
        <Card title="Outcomes">
          {breakdown.length ? <BarList data={breakdown} /> : <Empty title="No calls in this range" />}
        </Card>
      </div>

      <Card
        title="Call history"
        flush
        right={
          <select className="select" style={{ height: 28, width: 170 }} value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-label="Outcome">
            <option value="">All outcomes</option>
            {OUTCOMES.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        }
      >
        {calls.loading && !calls.data ? (
          <LoadingRows />
        ) : history.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Contact</th><th>Outcome</th><th className="right">Duration</th><th>Notes</th><th>Next step</th><th>Follow-up</th><th>When</th></tr></thead>
              <tbody>
                {history.slice(0, 200).map((c) => (
                  <tr key={c.id} className="clickable" onClick={() => nav(`/clients/${c.contactId}`)}>
                    <td><div style={{ fontWeight: 550 }}>{c.contactName}</div><div className="faint small">{c.companyName}</div></td>
                    <td><span className={`badge ${outcomeTone(c.outcome)}`}>{outcomeLabel(c.outcome)}</span></td>
                    <td className="right num">{duration(c.durationSec)}</td>
                    <td className="small ellipsis" style={{ maxWidth: 280 }}>{c.notes || <span className="faint">—</span>}</td>
                    <td className="small ellipsis" style={{ maxWidth: 200 }}>{c.nextStep || <span className="faint">—</span>}</td>
                    <td className="small">{c.followUpDate ? relTime(c.followUpDate) : <span className="faint">—</span>}</td>
                    <td className="small muted" style={{ whiteSpace: "nowrap" }}>{relTime(c.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No calls logged yet" />
        )}
      </Card>
    </div>
  );
}
