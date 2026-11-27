import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Clock, Columns3, Plus, Search, Sparkles, UserRound } from "lucide-react";
import { api, type Opportunity, type Pipeline } from "../lib/api.ts";
import { money, relTime } from "../lib/format.ts";
import { AiPanel } from "../components/AiPanel.tsx";
import { Card, Empty, ErrorState, LoadingRows, Modal, useAsync, useToast } from "../components/ui.tsx";
import { DealModal } from "../components/crm.tsx";
import { celebrate } from "../components/brand.tsx";

export function PipelinePage() {
  const nav = useNavigate();
  const toast = useToast();
  const pipelines = useAsync(() => api.get<Pipeline[]>("/api/pipelines"));
  const [pid, setPid] = useState("");
  const [q, setQ] = useState("");
  const [show, setShow] = useState<"open" | "all">("open");
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [review, setReview] = useState(false);
  const [deal, setDeal] = useState<Opportunity | { stageId: string } | null>(null);
  useEffect(() => {
    if (!pid && pipelines.data?.[0]) setPid(pipelines.data[0].id);
  }, [pipelines.data, pid]);
  const opps = useAsync(() => (pid ? api.get<Opportunity[]>(`/api/opportunities?pipelineId=${pid}`) : Promise.resolve([])), [pid]);
  const pipeline = pipelines.data?.find((p) => p.id === pid);

  const visible = useMemo(() => {
    const term = q.toLowerCase();
    return (opps.data ?? []).filter((o) => (show === "all" || o.status === "open" || o.status === "won") && (!term || `${o.name} ${o.contactName} ${o.companyName}`.toLowerCase().includes(term)));
  }, [opps.data, q, show]);

  const move = async (oppId: string, stageId: string) => {
    const o = opps.data?.find((x) => x.id === oppId);
    if (!o || o.stageId === stageId || !opps.data) return;
    const prev = opps.data;
    opps.setData(prev.map((x) => (x.id === oppId ? { ...x, stageId, lastStageChangeAt: new Date().toISOString() } : x)));
    try {
      await api.put(`/api/opportunities/${oppId}`, { stageId });
      const stageName = pipeline?.stages.find((s) => s.id === stageId)?.name ?? "";
      toast(`${o.name} → ${stageName}`);
      if (/won|closed|signed/i.test(stageName)) celebrate();
    } catch (e) {
      opps.setData(prev);
      toast(e instanceof Error ? e.message : "Move failed", "bad");
    }
  };

  const total = visible.filter((o) => o.status === "open").reduce((s, o) => s + o.value, 0);
  const DAY = 86_400_000;

  return (
    <div className="page" style={{ maxWidth: "none" }}>
      <div className="page-head">
        <div>
          <h2>Pipeline</h2>
          <p>{visible.length} deals · {money(total)} open · drag a card to move it — changes sync to GoHighLevel</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => setReview(true)}><Sparkles /> Pipeline review</button>
          <button className="btn primary" onClick={() => pipeline && setDeal({ stageId: pipeline.stages[0]?.id ?? "" })} disabled={!pipeline}><Plus /> New deal</button>
        </div>
      </div>
      <div className="row wrap">
        <select className="select" style={{ width: 220 }} value={pid} onChange={(e) => setPid(e.target.value)} aria-label="Pipeline">
          {pipelines.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div className="input-icon" style={{ width: 260 }}>
          <Search />
          <input className="input" placeholder="Filter deals" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="btn-group">
          <button className={`btn ${show === "open" ? "on" : ""}`} onClick={() => setShow("open")}>Open & won</button>
          <button className={`btn ${show === "all" ? "on" : ""}`} onClick={() => setShow("all")}>Include lost</button>
        </div>
      </div>
      {(pipelines.error || opps.error) && <ErrorState error={pipelines.error ?? opps.error ?? ""} onRetry={() => (pipelines.reload(), opps.reload())} />}
      {!pipeline ? (
        pipelines.loading ? <Card><LoadingRows /></Card> : <Card><Empty icon={<Columns3 />} title="No pipelines">Create a pipeline in GoHighLevel → Opportunities.</Empty></Card>
      ) : (
        <div className="board">
          {pipeline.stages.map((s) => {
            const cards = visible.filter((o) => o.stageId === s.id).sort((a, b) => b.value - a.value);
            return (
              <div
                key={s.id}
                className={`col ${over === s.id ? "over" : ""}`}
                onDragOver={(e) => (e.preventDefault(), setOver(s.id))}
                onDragLeave={() => setOver((o) => (o === s.id ? null : o))}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(null);
                  const id = e.dataTransfer.getData("text/plain");
                  if (id) void move(id, s.id);
                }}
              >
                <div className="col-head">
                  <span className="name">{s.name}</span>
                  <span className="count">{cards.length}</span>
                  <span className="sum">{money(cards.reduce((a, o) => a + o.value, 0), true)}</span>
                  <button className="btn sm ghost icon" style={{ width: 22, height: 22 }} aria-label={`Add deal to ${s.name}`} onClick={() => setDeal({ stageId: s.id })}><Plus /></button>
                </div>
                <div className="col-body">
                  {cards.map((o) => {
                    const idle = Math.floor((Date.now() - new Date(o.lastStageChangeAt ?? o.updatedAt).getTime()) / DAY);
                    return (
                      <div
                        key={o.id}
                        className={`deal ${dragId === o.id ? "dragging" : ""}`}
                        draggable
                        onDragStart={(e) => (e.dataTransfer.setData("text/plain", o.id), setDragId(o.id))}
                        onDragEnd={() => setDragId(null)}
                        onClick={() => setDeal(o)}
                        tabIndex={0}
                        onKeyDown={(e) => e.key === "Enter" && setDeal(o)}
                      >
                        <div className="t">{o.name}</div>
                        <div className="meta">
                          <span className="val">{money(o.value)}</span>
                          {o.status !== "open" && <span className={`badge ${o.status === "won" ? "good" : "bad"}`}>{o.status}</span>}
                          <span className="spacer" />
                          <span title={`In stage ${relTime(o.lastStageChangeAt ?? o.updatedAt)}`} style={{ color: idle > 14 && o.status === "open" ? "var(--warn)" : undefined, display: "inline-flex", alignItems: "center", gap: 3 }}>
                            <Clock size={11} /> {idle}d
                          </span>
                        </div>
                        {o.contactName && (
                          <div className="meta ellipsis">
                            <button
                              style={{ all: "unset", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (o.contactId) nav(`/clients/${o.contactId}`);
                              }}
                            >
                              <UserRound size={11} /> {o.contactName}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {!cards.length && <div className="faint small" style={{ padding: "16px 4px", textAlign: "center" }}>Drop deals here</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {deal && pipelines.data && (
        <DealModal
          deal={"id" in deal ? deal : undefined}
          pipelines={pipelines.data}
          pipelineId={pid}
          stageId={deal.stageId}
          onClose={() => setDeal(null)}
          onSaved={() => opps.reload()}
        />
      )}
      {review && (
        <Modal title="Pipeline review" onClose={() => setReview(false)} wide>
          <AiPanel playbookIds={["pipeline-review"]} />
        </Modal>
      )}
    </div>
  );
}
