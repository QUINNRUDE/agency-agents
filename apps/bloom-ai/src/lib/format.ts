export const money = (n: number, compact = false) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: compact && Math.abs(n) >= 10_000 ? 1 : 0,
    notation: compact && Math.abs(n) >= 10_000 ? "compact" : "standard",
  }).format(n);

export function moneyShort(n: number): string {
  if (Math.abs(n) < 1000) return `$${Math.round(n)}`;
  const k = n / 1000;
  return `$${Number.isInteger(k) || Math.abs(k) >= 100 ? Math.round(k) : k.toFixed(1)}K`;
}

export const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  const abs = Math.abs(diff);
  const fut = diff < 0;
  const m = Math.round(abs / 60_000);
  let s: string;
  if (m < 1) return "just now";
  if (m < 60) s = `${m}m`;
  else if (m < 60 * 24) s = `${Math.round(m / 60)}h`;
  else if (m < 60 * 24 * 30) s = `${Math.round(m / 1440)}d`;
  else if (m < 60 * 24 * 365) s = `${Math.round(m / 43200)}mo`;
  else s = `${Math.round(m / 525600)}y`;
  return fut ? `in ${s}` : `${s} ago`;
}

export const shortDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";

export const longDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "—";

export const timeOfDay = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

export const duration = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : (parts[0]?.[1] ?? ""))).toUpperCase() || "?";
}

export function phoneDisplay(p: string): string {
  const d = p.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return p;
}

export const OUTCOMES = [
  { id: "connected", label: "Connected", tone: "accent" },
  { id: "booked", label: "Booked meeting", tone: "good" },
  { id: "callback", label: "Callback", tone: "warn" },
  { id: "voicemail", label: "Voicemail", tone: "" },
  { id: "no_answer", label: "No answer", tone: "" },
  { id: "not_interested", label: "Not interested", tone: "bad" },
  { id: "wrong_number", label: "Wrong number", tone: "bad" },
] as const;

export const outcomeLabel = (id: string) => OUTCOMES.find((o) => o.id === id)?.label ?? id;
export const outcomeTone = (id: string) => OUTCOMES.find((o) => o.id === id)?.tone ?? "";
