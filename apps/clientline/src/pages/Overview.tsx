import { Link, useNavigate } from "react-router-dom";
import { ArrowDownRight, ArrowUpRight, CalendarClock, CircleDollarSign, Flame, Phone, PhoneCall, Plus, Snowflake, Target, Telescope, Trophy, UserPlus } from "lucide-react";
import { useState } from "react";
import { api, type Dashboard } from "../lib/api.ts";
import { money, moneyShort, outcomeLabel, outcomeTone, pct, relTime, shortDate, timeOfDay } from "../lib/format.ts";
import { Avatar, Banner, Card, Empty, ErrorState, LoadingRows, Skeleton, useAsync } from "../components/ui.tsx";
import { BarList, ColumnChart } from "../components/charts.tsx";
import { useApp } from "../App.tsx";
import { NewContactModal } from "./Clients.tsx";

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function Kpi({ icon: Icon, label, value, foot }: { icon: typeof Target; label: string; value: string; foot: React.ReactNode }) {
  return (
    <div className="card kpi">
      <div className="kpi-label">
        <Icon /> {label}
      </div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-foot">{foot}</div>
    </div>
  );
}

export function Overview() {
  const { status } = useApp();
  const nav = useNavigate();
  const [adding, setAdding] = useState(false);
  const { data, error, loading, reload } = useAsync(() => api.get<Dashboard>("/api/dashboard"));
  const k = data?.kpis;
  const leadDelta = k ? k.newContacts30 - k.newContactsPrev30 : 0;
  const today = new Date().toDateString();

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>{greeting()}</h2>
          <p>{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} · {data?.pipeline ? `Tracking ${data.pipeline.name}` : "Your client book at a glance"}</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => setAdding(true)}>
            <Plus /> New contact
          </button>
          <Link className="btn" to="/prospecting">
            <Telescope /> Find clients
          </Link>
          <Link className="btn primary" to="/calls">
            <PhoneCall /> Start calling
          </Link>
        </div>
      </div>

      {status?.crm.mode === "demo" && (
        <Banner tone="warn">
          You're looking at a demo workspace. <Link to="/settings#ghl">Connect GoHighLevel</Link> to work with your real contacts, pipeline and calendar — everything here switches over automatically.
        </Banner>
      )}
      {status && !status.ok && <Banner tone="bad">GoHighLevel connection failed: {status.error}</Banner>}
      {error && <ErrorState error={error} onRetry={reload} />}

      <div className="kpis">
        {loading && !k
          ? Array.from({ length: 5 }, (_, i) => (
              <div className="card kpi" key={i}>
                <Skeleton w="50%" />
                <Skeleton h={26} w="70%" />
                <Skeleton w="60%" />
              </div>
            ))
          : k && (
              <>
                <Kpi icon={CircleDollarSign} label="Open pipeline" value={money(k.openValue, true)} foot={`${k.openCount} deals · ${money(k.weighted, true)} weighted`} />
                <Kpi icon={Trophy} label="Won, last 30 days" value={money(k.wonValue30, true)} foot={`${k.wonCount30} deals closed`} />
                <Kpi icon={Target} label="Win rate, 90 days" value={pct(k.winRate90)} foot="Won ÷ (won + lost)" />
                <Kpi
                  icon={UserPlus}
                  label="New leads, 30 days"
                  value={String(k.newContacts30)}
                  foot={
                    <>
                      <span className={`delta ${leadDelta >= 0 ? "up" : "down"}`}>
                        {leadDelta >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
                        {Math.abs(leadDelta)}
                      </span>
                      vs previous 30 · {k.totalContacts} total
                    </>
                  }
                />
                <Kpi icon={Phone} label="Calls this week" value={String(k.callsWeek)} foot={`${pct(k.connectRate)} connect · ${k.booked} booked`} />
              </>
            )}
      </div>

      <div className="grid-dash">
        <div className="stack" style={{ gap: 16 }}>
          <Card title="Pipeline by stage" sub={data?.pipeline?.name} right={<Link to="/pipeline" className="small">Open board →</Link>}>
            {data ? (
              data.stages.length ? (
                <div className="funnel">
                  {data.stages.map((s) => (
                    <div className="funnel-step" key={s.id} title={`${s.name}: ${s.count} deals, ${money(s.value)}`}>
                      <span className="l">{s.name}</span>
                      <span className="n">{s.count}</span>
                      <span className="v">{moneyShort(s.value)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty title="No pipeline stages" />
              )
            ) : (
              <Skeleton h={80} />
            )}
            {data && k && (
              <div className="grid-3" style={{ marginTop: 16 }}>
                <div>
                  <div className="faint small">Average open deal</div>
                  <div className="num" style={{ fontSize: 17 }}>{k.openCount ? money(Math.round(k.openValue / k.openCount)) : "—"}</div>
                </div>
                <div>
                  <div className="faint small">Weighted forecast</div>
                  <div className="num" style={{ fontSize: 17 }}>{money(k.weighted)}</div>
                </div>
                <div>
                  <div className="faint small">Stalled 14+ days (top)</div>
                  <div className="num" style={{ fontSize: 17 }}>{data.stale.length ? `${data.stale.length} · ${moneyShort(data.stale.reduce((a, o) => a + o.value, 0))}` : "0"}</div>
                </div>
              </div>
            )}
          </Card>
          <Card title="New leads per week" sub="Last 12 weeks">
            {data ? <ColumnChart data={data.leadsByWeek} unit="leads" /> : <Skeleton h={180} />}
          </Card>
        </div>

        <div className="stack" style={{ gap: 16 }}>
          <Card title="Agenda" sub="Today & tomorrow" flush right={<CalendarClock size={15} className="faint" />}>
            {!data ? (
              <LoadingRows n={3} />
            ) : data.appointments.length ? (
              <div className="list">
                {data.appointments.map((a) => (
                  <div className="list-item clickable" key={a.id} onClick={() => a.contactId && nav(`/clients/${a.contactId}`)}>
                    <div style={{ width: 76, flex: "none" }}>
                      <div className="num small" style={{ whiteSpace: "nowrap" }}>{timeOfDay(a.startTime)}</div>
                      <div className="faint small">{new Date(a.startTime).toDateString() === today ? "Today" : shortDate(a.startTime)}</div>
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div className="t ellipsis">{a.title}</div>
                      <div className="s">{a.calendarName}{a.contactName ? ` · ${a.contactName}` : ""}</div>
                    </div>
                    {a.contactId && (
                      <Link className="btn sm ghost" to={`/calls/${a.contactId}`} onClick={(e) => e.stopPropagation()} style={{ marginLeft: "auto" }}>
                        Prep
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <Empty title="Nothing booked">Appointments from your GoHighLevel calendars show up here.</Empty>
            )}
          </Card>
          <Card title="Follow-ups due" flush right={<Link to="/calls" className="small">Call queue →</Link>}>
            {!data ? (
              <LoadingRows n={3} />
            ) : data.followUps.length ? (
              <div className="list">
                {data.followUps.map((f) => (
                  <div className="list-item clickable" key={f.id} onClick={() => nav(`/calls/${f.contactId}`)}>
                    <Avatar name={f.contactName} />
                    <div style={{ minWidth: 0 }}>
                      <div className="t ellipsis">{f.contactName}</div>
                      <div className="s ellipsis">{f.nextStep || outcomeLabel(f.outcome)}</div>
                    </div>
                    <span className="badge warn" style={{ marginLeft: "auto" }}>
                      {relTime(f.followUpDate)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <Empty title="You're caught up">Follow-ups you set when logging calls land here.</Empty>
            )}
          </Card>
        </div>
      </div>

      <div className="grid-halves">
        <Card title="Deals going cold" sub="No stage change in 14+ days" flush right={<Snowflake size={15} className="faint" />}>
          {!data ? (
            <LoadingRows />
          ) : data.stale.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Deal</th>
                    <th>Stage</th>
                    <th className="right">Idle</th>
                    <th className="right">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {data.stale.map((o) => (
                    <tr key={o.id} className="clickable" onClick={() => o.contactId && nav(`/clients/${o.contactId}`)}>
                      <td>
                        <div className="t ellipsis" style={{ maxWidth: 260, fontWeight: 550 }}>{o.name}</div>
                      </td>
                      <td><span className="badge">{o.stageName}</span></td>
                      <td className="right num">{o.idleDays}d</td>
                      <td className="right num">{money(o.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon={<Flame />} title="Nothing stalling">Every open deal moved in the last two weeks.</Empty>
          )}
        </Card>
        <Card title="Lead sources" sub="Contacts added, last 90 days">
          {data ? data.sources.length ? <BarList data={data.sources} /> : <Empty title="No new contacts in 90 days" /> : <Skeleton h={160} />}
        </Card>
      </div>

      <div className="grid-halves">
        <Card title="Recent calls" flush right={<Link to="/calls" className="small">All calls →</Link>}>
          {!data ? (
            <LoadingRows n={3} />
          ) : data.recentCalls.length ? (
            <div className="list">
              {data.recentCalls.map((c) => (
                <div className="list-item clickable" key={c.id} onClick={() => nav(`/clients/${c.contactId}`)}>
                  <Avatar name={c.contactName} />
                  <div style={{ minWidth: 0 }}>
                    <div className="t">{c.contactName}</div>
                    <div className="s ellipsis">{c.notes || c.companyName}</div>
                  </div>
                  <span className={`badge ${outcomeTone(c.outcome)}`} style={{ marginLeft: "auto" }}>{outcomeLabel(c.outcome)}</span>
                  <span className="faint small" style={{ width: 56, textAlign: "right" }}>{relTime(c.startedAt)}</span>
                </div>
              ))}
            </div>
          ) : (
            <Empty icon={<PhoneCall />} title="No calls logged yet">
              <Link to="/calls">Open the call queue</Link> to start a power-dialing session.
            </Empty>
          )}
        </Card>
        <Card title="Newest contacts" flush right={<Link to="/clients" className="small">All clients →</Link>}>
          {!data ? (
            <LoadingRows n={3} />
          ) : (
            <div className="list">
              {data.newestContacts.map((c) => (
                <div className="list-item clickable" key={c.id} onClick={() => nav(`/clients/${c.id}`)}>
                  <Avatar name={c.name} />
                  <div style={{ minWidth: 0 }}>
                    <div className="t">{c.name}</div>
                    <div className="s ellipsis">{[c.companyName, c.source].filter(Boolean).join(" · ")}</div>
                  </div>
                  <span className="faint small" style={{ marginLeft: "auto" }}>{relTime(c.dateAdded)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
      {adding && <NewContactModal onClose={() => setAdding(false)} onCreated={(c) => nav(`/clients/${c.id}`)} />}
    </div>
  );
}
