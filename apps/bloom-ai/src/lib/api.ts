import type { Appointment, Contact, CustomField, Message, Note, Opportunity, Pipeline, Task, User } from "../../server/crm/types.ts";
import type { CallLog, CallOutcome, Prospect, SavedView, SiteAudit } from "../../server/store.ts";
import type { AgentMeta, Agent } from "../../server/agents.ts";

export type { Appointment, Contact, CustomField, Message, Note, Opportunity, Pipeline, Task, User, SavedView, CallLog, CallOutcome, Prospect, SiteAudit, AgentMeta, Agent };

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Lets the sidebar refresh its overdue-task count after any task change. */
export const TASKS_CHANGED = "bloom:tasks-changed";

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (res.ok && method !== "GET" && /\/tasks|\/api\/calls$|\/api\/contacts\/bulk/.test(url)) window.dispatchEvent(new Event(TASKS_CHANGED));
  if (res.status === 401 && data && typeof data === "object" && "login" in data) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
  }
  if (!res.ok) {
    const msg = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : `Request failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

export const api = {
  del: <T,>(url: string, body?: unknown) => request<T>("DELETE", url, body),
  get: <T,>(url: string) => request<T>("GET", url),
  post: <T,>(url: string, body?: unknown) => request<T>("POST", url, body ?? {}),
  put: <T,>(url: string, body?: unknown) => request<T>("PUT", url, body ?? {}),
  patch: <T,>(url: string, body?: unknown) => request<T>("PATCH", url, body ?? {}),
};

export interface Status {
  ok: boolean;
  crm: { mode: "ghl" | "demo"; accountName: string };
  has: { ghl: boolean; claude: boolean; places: boolean; meta: boolean };
  authEnabled?: boolean;
  error?: string;
}

export interface Playbook {
  id: string;
  label: string;
  agentSlug: string;
  agentName: string;
  summary: string;
  effort: string;
}

export interface ContactBundle {
  contact: Contact;
  notes: Note[];
  tasks: Task[];
  messages: Message[];
  opportunities: Opportunity[];
  pipelines: Pipeline[];
  users: User[];
  customFields: CustomField[];
  calls: CallLog[];
  warnings: string[];
}

export interface Meta {
  users: User[];
  customFields: CustomField[];
}

export interface QueueItem {
  contact: Contact;
  score: number;
  reasons: string[];
  opportunity: Opportunity | null;
  stage: string | null;
  lastCall: CallLog | null;
}

export interface Dashboard {
  pipeline: { id: string; name: string } | null;
  kpis: {
    openValue: number;
    openCount: number;
    weighted: number;
    wonValue30: number;
    wonCount30: number;
    winRate90: number | null;
    newContacts30: number;
    newContactsPrev30: number;
    callsWeek: number;
    connectRate: number | null;
    booked: number;
    totalContacts: number;
  };
  stages: { id: string; name: string; count: number; value: number }[];
  leadsByWeek: { label: string; value: number }[];
  sources: { label: string; value: number }[];
  stale: (Opportunity & { idleDays: number; stageName: string })[];
  appointments: (Appointment & { contactName: string })[];
  followUps: CallLog[];
  tasksDue: Task[];
  tasksOverdue: number;
  tasksToday: number;
  spark: { leads: number[]; calls: number[]; won: number[] };
  today: { calls: number; callGoal: number; newLeads: number; automated: number };
  ads: { sample: boolean; spend: number; leads: number; cpl: number | null; roas: number | null; currency: string; daily: number[] } | null;
  recentCalls: CallLog[];
  newestContacts: Contact[];
}

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

/** POSTs and reads a server-sent-event stream. Returns an abort function. */
export function stream(url: string, body: unknown, h: StreamHandlers): () => void {
  const ctrl = new AbortController();
  (async () => {
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
      if (!res.ok || !res.body) {
        const t = await res.text();
        let msg = `Request failed (${res.status})`;
        try {
          msg = JSON.parse(t).error ?? msg;
        } catch {
          /* not json */
        }
        h.onError?.(msg);
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let finished = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const event = /^event: (.*)$/m.exec(chunk)?.[1] ?? "message";
          const dataLine = /^data: (.*)$/m.exec(chunk)?.[1];
          if (!dataLine) continue;
          const data = JSON.parse(dataLine);
          if (event === "delta") h.onDelta(data.text);
          else if (event === "error") {
            finished = true;
            h.onError?.(data.message);
          } else if (event === "done") {
            finished = true;
            h.onDone?.();
          }
        }
      }
      if (!finished) h.onDone?.();
    } catch (err) {
      if (ctrl.signal.aborted) return;
      h.onError?.(err instanceof Error ? err.message : String(err));
    }
  })();
  return () => ctrl.abort();
}
