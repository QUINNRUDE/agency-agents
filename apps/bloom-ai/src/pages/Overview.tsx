import { Link, useNavigate } from "react-router-dom";
import { ArrowDownRight, ArrowUpRight, CalendarClock, CheckSquare, CircleDollarSign, Flame, Inbox as InboxIcon, Megaphone, Phone, PhoneCall, Plus, Snowflake, Target, Telescope, Trophy, UserPlus } from "lucide-react";
import { Petals, Ring, Sparkline } from "../components/brand.tsx";
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

function Kpi({ icon: Icon, label, value, foot, tint, spark }: { icon: typeof Target; label: string; value: string; foot: React.ReactNode; tint: string; spark?: number[] }) {
  return (
    <div className="card kpi2 lift">
      <div className="top">
        <span className={`ichip ${tint}`}><Icon /></span>
        <span className="label">{label}</span>
      </div>
      <div className="value">{value}</div>
      <div className="foot">{foot}</div>
      {spark && spark.some((v) => v > 0) && <Sparkline data={spark} width={72} height={26} />}
    </div>
  );
}

export function Overview() {
  const { status } = useApp();
  const nav = useNavigate();
  const [adding, setAdding] = useState(false);
  const { data, error, loading, reload } = useAsync(() => api.get<Dashboard>("/api/dashboard"));
  const settings = useAsync(() => api.get<{ profile: { yourName: string } }>("/api/settings"));
  const profileName = settings.data?.profile.yourName?.split(" ")[0] ?? "";
  const k = data?.kpis;
  const leadDelta = k ? k.newContacts30 - k.newContactsPrev30 : 0;
  const today = new Date().toDateString();

  return (
    <div className="page">
      <section className="hero">
        <Petals className="petals" />
        <div style={{ position: "relative" }}>
          <h2>
            {greeting()}
            {profileName ? `, ${profileName}` : ""}
          </h2>
          <p>
            {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
            {data ? ` · ${data.tasksDue.length + data.followUps.length} things due today · ${data.appointments.filter((a) => new Date(a.startTime).toDateString() === today).length} meetings` : ""}
          </p>
          <div className="hero-stats">
            <div className="glass"><b>{data?.today.newLeads ?? "–"}</b><span>new leads today</span></div>
            <div className="glass"><b>{data?.today.automated ?? "–"}</b><span>auto-messages, 24h</span></div>
            <div className="glass"><b>{k ? moneyShort(k.openValue) : "–"}</b><span>open pipeline</span></div>
            {data?.ads && (data.ads.sample || data.ads.connected) && <div className="glass"><b>{data.ads.roas === null ? moneyShort(data.ads.spend) : `${data.ads.roas.toFixed(1)}x`}</b><span>{data.ads.roas === null ? "ad spend, 30d" : "ad ROAS, 30d"}{data.ads.sample ? " (sample)" : ""}</span></div>}
          </div>
          <div className="row wrap" style={{ marginTop: 16 }}>
            <Link className="btn" to="/calls"><PhoneCall /> Start calling</Link>
            <Link className="btn ghosty" to="/inbox"><InboxIcon /> Inbox</Link>
            <button className="btn ghosty" onClick={() => setAdding(true)}><Plus /> New contact</button>
            <Link className="btn ghosty" to="/prospecting"><Telescope /> Find clients</Link>
          </div>
        </div>
        <div style={{ position: "relative", display: "grid", justifyItems: "center", gap: 6 }}>
          <Ring value={data?.today.calls ?? 0} max={data?.today.callGoal ?? 20} label="calls today" />
          <span style={{ fontSize: 12, opacity: 0.9 }}>{data && data.today.calls >= data.today.callGoal ? "Goal hit — nice work" : "Daily call goal"}</span>
        </div>
      </section>

      {status?.crm.mode === "demo" && status.demoData !== false && (
        <Banner tone="warn">
          You're looking at a demo workspace. <Link to="/settings#ghl">Connect GoHighLevel</Link> to work with your real contacts, pipeline and calendar, or <Link to="/settings#demo">remove the demo data</Link> to start with a clean workspace.
        </Banner>
      )}
      {status?.crm.mode === "demo" && status.demoData === false && (
        <Banner tone="info">
          Your workspace is ready. Add clients with <Link to="/prospecting">Find clients</Link> or <Link to="/clients">Clients → Import</Link>, or <Link to="/settings#ghl">connect GoHighLevel</Link> to bring in your contacts. Texts and emails are only sent once GoHighLevel is connected.
        </Banner>
      )}
      {status && !status.ok && <Banner tone="bad">GoHighLevel connection failed: {status.error}</Banner>}
      {error && <ErrorState error={error} onRetry={reload} />}

      <div className="kpis">
        {loading && !k
          ? Array.from({ length: 5 }, (_, i) => (
              <div className="card kpi2" key={i}>
                <Skeleton w="50%" />
                <Skeleton h={26} w="70%" />
                <Skeleton w="60%" />
              </div>
            ))
          : k &&
            data && (
              <>
                <Kpi icon={CircleDollarSign} tint="rose" label="Open pipeline" value={money(k.openValue, true)} foot={`${k.openCount} deals · ${money(k.weighted, true)} weighted`} />
                <Kpi icon={Trophy} tint="amber" label="Won, last 30 days" value={money(k.wonValue30, true)} foot={`${k.wonCount30} deals closed`} spark={data.spark.won} />
                <Kpi icon={Target} tint="violet" label="Win rate, 90 days" value={pct(k.winRate90)} foot="won ÷ (won + lost)" />
                <Kpi
                  icon={UserPlus}
                  tint="teal"
                  label="New leads, 30 days"
                  value={String(k.newContacts30)}
                  spark={data.spark.leads}
                  foot={
                    <>
                      <span className={`delta ${leadDelta >= 0 ? "up" : "down"}`}>
                        {leadDelta >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
                        {Math.abs(leadDelta)}
                      </span>
                      vs previous 30
                    </>
                  }
                />
                <Kpi icon={Phone} tint="sky" label="Calls this week" value={String(k.callsWeek)} foot={`${pct(k.connectRate)} connect · ${k.booked} booked`} spark={data.spark.calls} />
              </>
            )}
      </div>

      {data?.ads && (data.ads.sample || data.ads.connected) && (
        <Link to="/ads" className="card lift" style={{ padding: "14px 16px", display: "grid", gridTemplateColumns: "auto minmax(0,1fr) auto", gap: 16, alignItems: "center", textDecoration: "none", color: "inherit" }}>
          <span className="ichip grad"><Megaphone /></span>
          <div className="row wrap" style={{ gap: 22 }}>
            <div><div className="faint small">Meta ad spend, 30d{data.ads.sample ? " (sample)" : ""}</div><div className="num" style={{ fontSize: 18 }}>{money(data.ads.spend, true)}</div></div>
            <div><div className="faint small">Meta leads</div><div className="num" style={{ fontSize: 18 }}>{data.ads.leads}</div></div>
            <div><div className="faint small">Cost per lead</div><div className="num" style={{ fontSize: 18 }}>{data.ads.cpl === null ? "—" : money(data.ads.cpl)}</div></div>
            <div><div className="faint small">ROAS (won revenue)</div><div className="num" style={{ fontSize: 18 }}>{data.ads.roas === null ? "—" : `${data.ads.roas.toFixed(1)}x`}</div></div>
          </div>
          <Sparkline data={data.ads.daily} width={140} height={36} />
        </Link>
      )}

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
          <Card
            title="Due today"
            sub={data && data.tasksOverdue ? <span style={{ color: "var(--bad)" }}>{data.tasksOverdue} overdue</span> : undefined}
            flush
            right={<Link to="/tasks" className="small">All tasks →</Link>}
          >
            {!data ? (
              <LoadingRows n={3} />
            ) : data.tasksDue.length || data.followUps.length ? (
              <div className="list">
                {data.tasksDue.map((t) => {
                  const overdue = new Date(t.dueDate).getTime() < new Date().setHours(0, 0, 0, 0);
                  return (
                    <div className="list-item clickable" key={t.id} onClick={() => nav(`/clients/${t.contactId}`)}>
                      <span className="tl-icon"><CheckSquare /></span>
                      <div style={{ minWidth: 0 }}>
                        <div className="t ellipsis">{t.title}</div>
                        <div className="s ellipsis">{t.contactName}</div>
                      </div>
                      <span className={`badge ${overdue ? "bad" : "warn"}`} style={{ marginLeft: "auto" }}>{overdue ? relTime(t.dueDate) : "Today"}</span>
                    </div>
                  );
                })}
                {data.followUps.map((f) => (
                  <div className="list-item clickable" key={f.id} onClick={() => nav(`/calls/${f.contactId}`)}>
                    <span className="tl-icon"><Phone /></span>
                    <div style={{ minWidth: 0 }}>
                      <div className="t ellipsis">Call back {f.contactName}</div>
                      <div className="s ellipsis">{f.nextStep || outcomeLabel(f.outcome)}</div>
                    </div>
                    <span className="badge warn" style={{ marginLeft: "auto" }}>{relTime(f.followUpDate)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <Empty title="You're caught up">Tasks and call follow-ups due today land here.</Empty>
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
