import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { initials } from "../lib/format.ts";

// ---------- data hook ----------
export function useAsync<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const run = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true);
    try {
      const v = await load();
      if (n === seq.current) {
        setData(v);
        setError(null);
      }
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (n === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void run();
  }, [run]);
  return { data, error, loading, reload: run, setData };
}

// ---------- toasts ----------
interface ToastItem {
  id: number;
  text: string;
  tone: "ok" | "bad";
}
const ToastCtx = createContext<(text: string, tone?: "ok" | "bad") => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((text: string, tone: "ok" | "bad" = "ok") => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), tone === "bad" ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.tone === "bad" ? "bad" : ""}`}>
            {t.tone === "bad" ? <XCircle /> : <CheckCircle2 />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- primitives ----------
export function Card({ title, sub, right, children, flush, className = "" }: { title?: ReactNode; sub?: ReactNode; right?: ReactNode; children: ReactNode; flush?: boolean; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || right) && (
        <div className="card-head">
          {title && <h3>{title}</h3>}
          {sub && <span className="sub">{sub}</span>}
          {right && <div className="right">{right}</div>}
        </div>
      )}
      <div className={`card-body ${flush ? "flush" : ""}`}>{children}</div>
    </section>
  );
}

export function Avatar({ name, size }: { name: string; size?: "lg" }) {
  return (
    <span className={`avatar ${size ?? ""}`} aria-hidden>
      {initials(name)}
    </span>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export function Skeleton({ h = 14, w = "100%" }: { h?: number; w?: number | string }) {
  return <div className="skeleton" style={{ height: h, width: w }} />;
}

export function LoadingRows({ n = 5 }: { n?: number }) {
  return (
    <div className="stack" style={{ padding: 16 }}>
      {Array.from({ length: n }, (_, i) => (
        <Skeleton key={i} w={`${90 - ((i * 13) % 35)}%`} />
      ))}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <strong>{title}</strong>
      {children && <div className="small">{children}</div>}
    </div>
  );
}

export function Banner({ tone = "info", children }: { tone?: "info" | "warn" | "bad"; children: ReactNode }) {
  const Icon = tone === "bad" ? XCircle : tone === "warn" ? AlertTriangle : Info;
  return (
    <div className={`banner ${tone}`}>
      <Icon />
      <div className="banner-text">{children}</div>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <Banner tone="bad">
      <div className="row wrap">
        <span>{error}</span>
        {onRetry && (
          <button className="btn sm" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    </Banner>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{title}</h3>
          <span className="spacer" />
          <button className="btn ghost sm icon" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Labelled form field. Use `group` when the children hold several controls (a <label> would forward clicks to the first one). */
export function Field({ label, hint, children, group }: { label: string; hint?: ReactNode; children: ReactNode; group?: boolean }) {
  const Tag = group ? "div" : "label";
  return (
    <Tag className="field" role={group ? "group" : undefined} aria-label={group ? label : undefined}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </Tag>
  );
}

export function ScoreBadge({ score }: { score: number }) {
  return <span className={`score ${score >= 70 ? "hi" : score >= 50 ? "mid" : "lo"}`}>{score}</span>;
}
