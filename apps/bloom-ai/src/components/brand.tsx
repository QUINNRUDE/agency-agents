import { useEffect, useId, useState } from "react";
import { AtSign, Mail, MessageCircle, MessageSquare, Phone } from "lucide-react";

export const ACCENTS = [
  { id: "rose", label: "Rose", colors: ["#ff8a4c", "#f43f74", "#c026d3"] },
  { id: "violet", label: "Violet", colors: ["#60a5fa", "#8b5cf6", "#ec4899"] },
  { id: "ocean", label: "Ocean", colors: ["#2dd4bf", "#0ea5e9", "#6366f1"] },
  { id: "sunset", label: "Sunset", colors: ["#fbbf24", "#f97316", "#e11d48"] },
  { id: "forest", label: "Forest", colors: ["#a3e635", "#10b981", "#0d9488"] },
] as const;
export type AccentId = (typeof ACCENTS)[number]["id"];

const KEY = "bloom-accent";
function readAccent(): AccentId {
  try {
    const v = localStorage.getItem(KEY);
    return ACCENTS.some((a) => a.id === v) ? (v as AccentId) : "rose";
  } catch {
    return "rose";
  }
}

/** The colour theme lives on <html data-accent>; every component reads it through CSS variables. */
export function applyAccent(id: AccentId) {
  document.documentElement.dataset.accent = id;
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* storage unavailable: theme still applies for this visit */
  }
  window.dispatchEvent(new Event("bloom:accent"));
}

export function useAccent(): [AccentId, (id: AccentId) => void] {
  const [accent, setAccent] = useState<AccentId>(readAccent);
  useEffect(() => {
    const on = () => setAccent(readAccent());
    window.addEventListener("bloom:accent", on);
    return () => window.removeEventListener("bloom:accent", on);
  }, []);
  return [accent, applyAccent];
}

applyAccentOnLoad();
function applyAccentOnLoad() {
  if (typeof document !== "undefined") document.documentElement.dataset.accent = readAccent();
}

export function Swatch({ id, on, onClick, size }: { id: AccentId; on: boolean; onClick: () => void; size?: "big" }) {
  const a = ACCENTS.find((x) => x.id === id)!;
  const btn = (
    <span
      className={`swatch ${on ? "on" : ""}`}
      style={{ background: `linear-gradient(135deg, ${a.colors[0]}, ${a.colors[1]} 55%, ${a.colors[2]})`, display: "inline-block" }}
    />
  );
  if (size === "big")
    return (
      <button className="swatch-big" onClick={onClick} aria-pressed={on}>
        {btn}
        {a.label}
      </button>
    );
  return (
    <button onClick={onClick} aria-label={`${a.label} theme`} aria-pressed={on} title={a.label} style={{ all: "unset", cursor: "pointer", display: "inline-flex" }}>
      {btn}
    </button>
  );
}

/** Five-petal bloom mark, filled with the current theme gradient. */
export function Logo({ size = 22 }: { size?: number }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: "var(--g1)" }} />
          <stop offset="0.55" style={{ stopColor: "var(--g2)" }} />
          <stop offset="1" style={{ stopColor: "var(--g3)" }} />
        </linearGradient>
      </defs>
      {[0, 72, 144, 216, 288].map((r) => (
        <ellipse key={r} cx="16" cy="9" rx="5.2" ry="8" fill={`url(#g${id})`} opacity="0.92" transform={`rotate(${r} 16 16)`} />
      ))}
      <circle cx="16" cy="16" r="3.6" fill="#fff" />
    </svg>
  );
}

export function Petals({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden>
      {[0, 72, 144, 216, 288].map((r) => (
        <ellipse key={r} cx="16" cy="9" rx="5.2" ry="8" fill="#fff" transform={`rotate(${r} 16 16)`} />
      ))}
    </svg>
  );
}

export function Sparkline({ data, width = 96, height = 30 }: { data: number[]; width?: number; height?: number }) {
  const id = useId().replace(/:/g, "");
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const step = width / (data.length - 1);
  const y = (v: number) => height - 2 - ((v - min) / (max - min || 1)) * (height - 4);
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`);
  return (
    <svg className="spark" width={width} height={height} aria-hidden>
      <defs>
        <linearGradient id={`s${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: "var(--accent)", stopOpacity: 0.28 }} />
          <stop offset="1" style={{ stopColor: "var(--accent)", stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      <path d={`M0,${height} L${pts.join(" L")} L${width},${height} Z`} fill={`url(#s${id})`} />
      <polyline className="spark-line" points={pts.join(" ")} />
      <circle cx={(data.length - 1) * step} cy={y(data[data.length - 1])} r="2.6" fill="var(--accent)" />
    </svg>
  );
}

/** Progress ring for goals. Renders on the hero gradient, so it uses white. */
export function Ring({ value, max, size = 118, label }: { value: number; max: number; size?: number; label: string }) {
  const r = size / 2 - 9;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, max ? value / max : 0));
  return (
    <div className="ring-wrap" style={{ width: size, height: size }} role="img" aria-label={`${label}: ${value} of ${max}`}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="9" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="#fff"
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          style={{ transition: "stroke-dashoffset 0.9s cubic-bezier(0.2,0.7,0.2,1)" }}
        />
      </svg>
      <div className="center">
        <b>
          {value}
          <span style={{ fontSize: 13, opacity: 0.8 }}>/{max}</span>
        </b>
        <span>{label}</span>
      </div>
    </div>
  );
}

/** A short confetti burst in the theme colours — for wins. */
export function celebrate() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const styles = getComputedStyle(document.documentElement);
  const colors = ["--g1", "--g2", "--g3"].map((v) => styles.getPropertyValue(v).trim()).concat(["#ffffff", "#fcd34d"]);
  const wrap = document.createElement("div");
  wrap.className = "confetti";
  for (let i = 0; i < 90; i++) {
    const p = document.createElement("i");
    p.style.left = `${Math.random() * 100}vw`;
    p.style.background = colors[i % colors.length];
    p.style.setProperty("--dx", `${(Math.random() - 0.5) * 240}px`);
    p.style.setProperty("--rot", `${Math.random() * 900 - 450}deg`);
    p.style.animationDelay = `${Math.random() * 0.35}s`;
    p.style.width = `${6 + Math.random() * 6}px`;
    wrap.appendChild(p);
  }
  document.body.appendChild(wrap);
  setTimeout(() => wrap.remove(), 2400);
}

export const CHANNEL_NAMES: Record<string, string> = { SMS: "SMS", Email: "Email", FB: "Messenger", IG: "Instagram", WhatsApp: "WhatsApp", Call: "Call", "Live chat": "Live chat" };

/** Generic camera-square and chat-bolt glyphs for Instagram and Messenger (no brand artwork). */
function IgGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}
function FbGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden>
      <path d="M12 3C7 3 3 6.7 3 11.3c0 2.6 1.3 4.9 3.3 6.4V21l3-1.7c.9.3 1.8.4 2.7.4 5 0 9-3.7 9-8.4S17 3 12 3Z" />
      <path d="m7.5 13.5 3-3 2.2 2 3.8-3.5-3 3.8-2.2-2Z" fill="currentColor" />
    </svg>
  );
}

export function ChannelIcon({ channel, size = 12 }: { channel: string; size?: number }) {
  const p = { size, "aria-hidden": true } as const;
  if (channel === "IG") return <IgGlyph size={size} />;
  if (channel === "FB") return <FbGlyph size={size} />;
  if (channel === "WhatsApp") return <MessageCircle {...p} />;
  if (channel === "Email") return <Mail {...p} />;
  if (channel === "Call") return <Phone {...p} />;
  if (channel === "SMS") return <MessageSquare {...p} />;
  return <AtSign {...p} />;
}

export function ChannelBadge({ channel }: { channel: string }) {
  return (
    <span className={`ch ${channel}`}>
      <ChannelIcon channel={channel} /> {CHANNEL_NAMES[channel] ?? channel}
    </span>
  );
}

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" className={`toggle ${on ? "on" : ""}`} role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} />;
}
