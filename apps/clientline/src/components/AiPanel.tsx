import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Copy, NotebookPen, Send, Sparkles, Square } from "lucide-react";
import { api, stream, type Playbook } from "../lib/api.ts";
import { Markdown } from "../lib/markdown.tsx";
import { useApp } from "../App.tsx";
import { Banner, useToast } from "./ui.tsx";

interface Props {
  playbookIds: string[];
  contactId?: string;
  prospectId?: string;
  defaultId?: string;
  extraLabel?: string;
  extraPlaceholder?: string;
  onSaved?: () => void;
  onSendFollowUp?: (draft: { subject: string; email: string; sms: string }) => void;
  compact?: boolean;
  /** Optional external trigger: when this changes to a non-empty value, run with it as the extra input. */
  autoRun?: { id: string; extra: string; nonce: number } | null;
  /** Prefills the extra-context box (e.g. live call notes). */
  seedExtra?: string;
}

export function parseFollowUp(text: string) {
  const subject = /SUBJECT:\s*(.+)/i.exec(text)?.[1]?.trim() ?? "";
  const email = /EMAIL:\s*\n([\s\S]*?)(?:\n\s*SMS:|$)/i.exec(text)?.[1]?.trim() ?? "";
  const sms = /SMS:\s*\n?([\s\S]*)$/i.exec(text)?.[1]?.trim() ?? "";
  return { subject, email, sms };
}

export function AiPanel({ playbookIds, contactId, prospectId, defaultId, extraLabel, extraPlaceholder, onSaved, onSendFollowUp, compact, autoRun, seedExtra }: Props) {
  const { playbooks, status } = useApp();
  const toast = useToast();
  const list = playbookIds.map((id) => playbooks.find((p) => p.id === id)).filter((p): p is Playbook => Boolean(p));
  const [sel, setSel] = useState(defaultId ?? list[0]?.id ?? "");
  const [extra, setExtra] = useState(seedExtra ?? "");
  const [out, setOut] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  const current = list.find((p) => p.id === sel);

  useEffect(() => () => stopRef.current?.(), []);

  const run = (id = sel, extraText = extra) => {
    stopRef.current?.();
    setOut("");
    setErr(null);
    setRunning(true);
    stopRef.current = stream(
      "/api/ai/playbook",
      { playbookId: id, contactId, prospectId, extra: extraText },
      {
        onDelta: (t) => setOut((o) => o + t),
        onDone: () => setRunning(false),
        onError: (m) => {
          setErr(m);
          setRunning(false);
        },
      },
    );
  };

  useEffect(() => {
    if (autoRun && autoRun.nonce) {
      setSel(autoRun.id);
      setExtra(autoRun.extra);
      run(autoRun.id, autoRun.extra);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun?.nonce]);

  const stop = () => {
    stopRef.current?.();
    setRunning(false);
  };

  const saveNote = async () => {
    if (!contactId || !out) return;
    try {
      await api.post(`/api/contacts/${contactId}/notes`, { body: `${current?.label ?? "Agent output"} (${current?.agentName ?? "Clientline"})\n\n${out}` });
      toast("Saved to the client's notes");
      onSaved?.();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not save", "bad");
    }
  };

  if (!status?.has.claude) {
    return (
      <Banner tone="info">
        Agent playbooks run on Claude. <Link to="/settings#claude">Add your Anthropic API key</Link> to turn on call prep, scripts, follow-ups and proposals.
      </Banner>
    );
  }

  return (
    <div className="stack">
      {list.length > 1 && (
        <div className="pb-grid">
          {list.map((p) => (
            <button key={p.id} className={`pb ${p.id === sel ? "on" : ""}`} onClick={() => setSel(p.id)} type="button">
              <span className="t">{p.label}</span>
              {!compact && <span className="s">{p.summary}</span>}
            </button>
          ))}
        </div>
      )}
      {current && (
        <div className="small faint">
          Runs <Link to={`/agents?open=${current.agentSlug}`}>{current.agentName}</Link> from the Agency roster with this {prospectId ? "prospect's" : "client's"} CRM history.
        </div>
      )}
      {(extraLabel || sel === "objection" || sel === "call-summary") && (
        <textarea
          className="textarea"
          rows={sel === "call-summary" ? 4 : 2}
          placeholder={sel === "objection" ? "What did they say? e.g. “We already have someone doing our marketing.”" : sel === "call-summary" ? "Paste or type your raw call notes" : extraPlaceholder}
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          aria-label={extraLabel ?? "Additional context"}
        />
      )}
      <div className="row">
        {running ? (
          <button className="btn" onClick={stop}>
            <Square /> Stop
          </button>
        ) : (
          <button className="btn primary" onClick={() => run()} disabled={!sel}>
            <Sparkles /> {out ? "Run again" : `Run ${current?.label.toLowerCase() ?? "playbook"}`}
          </button>
        )}
        <span className="spacer" />
        {out && !running && (
          <>
            <button className="btn sm ghost" onClick={() => void navigator.clipboard.writeText(out).then(() => toast("Copied"))}>
              <Copy /> Copy
            </button>
            {contactId && (
              <button className="btn sm ghost" onClick={saveNote}>
                <NotebookPen /> Save as note
              </button>
            )}
            {onSendFollowUp && sel === "follow-up" && (
              <button className="btn sm" onClick={() => onSendFollowUp(parseFollowUp(out))}>
                <Send /> Review & send
              </button>
            )}
          </>
        )}
      </div>
      {err && <Banner tone="bad">{err}</Banner>}
      {(out || running) && (
        <div className="card" style={{ padding: 14, background: "var(--surface-2)" }}>
          {out ? <Markdown text={out} streaming={running} /> : <span className="faint small caret">Thinking</span>}
        </div>
      )}
    </div>
  );
}
