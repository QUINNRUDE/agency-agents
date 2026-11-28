// Claude-powered playbooks. Each playbook runs a specific agent from the
// Agency Agents repo (its markdown is the system prompt) against real client
// context pulled from the CRM, and streams the answer back to the browser.
import Anthropic from "@anthropic-ai/sdk";
import type { Response } from "express";
import { getAgent, type Agent } from "./agents.ts";
import { getSettings, type BusinessProfile } from "./config.ts";
import type { Contact, Message } from "./crm/types.ts";

export interface Playbook {
  id: string;
  label: string;
  agentSlug: string;
  summary: string;
  effort: "low" | "medium" | "high";
  task: string;
}

export const PLAYBOOKS: Playbook[] = [
  {
    id: "call-prep",
    label: "Call prep brief",
    agentSlug: "sales-discovery-coach",
    summary: "One-page brief before you dial: context, goals, questions, risks.",
    effort: "medium",
    task: `Prepare me for my next call with this client. Output, in this order:
1. **Where things stand** — 2-3 sentences from the notes, deal stage and history.
2. **Call objective** — the single outcome that makes this call a win, and the fallback outcome.
3. **Opening (first 20 seconds)** — word for word.
4. **Discovery questions** — 6-8 questions in the order I should ask them, each with what I'm listening for.
5. **Likely objections** — the 3 most probable given what we know, with a short response to each.
6. **Next step to propose** — specific, with a time.
Keep it scannable. No preamble.`,
  },
  {
    id: "cold-call-script",
    label: "Cold call script",
    agentSlug: "sales-outbound-strategist",
    summary: "Permission-based opener, pattern interrupt, and booking ask.",
    effort: "medium",
    task: `Write a cold call script for this prospect. Include: a permission-based opener, a one-line reason for the call tied to something specific about their business, 3 qualifying questions, a short value statement using my offer, the meeting ask with two time options, and branches for "not interested", "send me an email", "we already have someone", and voicemail (under 25 seconds). Use plain spoken language.`,
  },
  {
    id: "objection",
    label: "Live objection help",
    agentSlug: "sales-coach",
    summary: "Fast, word-for-word responses while you're on the call.",
    effort: "low",
    task: `I'm live on a call with this client. They just raised the objection below. Give me: the likely real concern behind it (one line), then exactly what to say back (2-4 sentences, conversational), then one follow-up question to keep the conversation going. Be brief — I'm reading this mid-call.`,
  },
  {
    id: "call-summary",
    label: "Post-call summary",
    agentSlug: "project-management-meeting-notes-specialist",
    summary: "Turns your raw call notes into a clean summary and next steps.",
    effort: "low",
    task: `Turn my raw call notes (below) into a CRM-ready summary: **Summary** (3 bullets), **Pain points**, **Budget / timeline / decision makers** (mark unknown where not stated), **Commitments made** (by us / by them), **Next step** with date. Do not invent facts that are not in the notes.`,
  },
  {
    id: "follow-up",
    label: "Follow-up message",
    agentSlug: "sales-outreach",
    summary: "Email and SMS follow-ups written from the call and history.",
    effort: "low",
    task: `Write a follow-up for this client based on the latest notes and calls. Give me two versions: (A) an email with a subject line, under 120 words, and (B) an SMS under 300 characters. Reference something specific from our conversation, restate the next step, and include my booking link if one is set. No buzzwords. Format exactly:
SUBJECT: ...
EMAIL:
...
SMS:
...`,
  },
  {
    id: "proposal",
    label: "Proposal draft",
    agentSlug: "sales-proposal-strategist",
    summary: "A win-theme proposal outline grounded in their pain points.",
    effort: "high",
    task: `Draft a proposal for this client. Structure: executive summary written in their language, the problem as they described it, proposed solution (scope, deliverables, timeline by phase), expected outcomes with how we'll measure them, investment (use my price range; present 2-3 options), why us, and next steps. Base everything on the notes; call out assumptions explicitly.`,
  },
  {
    id: "deal-review",
    label: "Deal strategy review",
    agentSlug: "sales-deal-strategist",
    summary: "MEDDPICC-style qualification and the plan to close.",
    effort: "medium",
    task: `Review this deal. Score each qualification element (metrics, economic buyer, decision criteria, decision process, paper process, pain, champion, competition) as Strong / Partial / Missing with one-line evidence. Then: the biggest risk to this deal, the 3 actions to take this week, and a realistic close probability with reasoning.`,
  },
  {
    id: "account-plan",
    label: "Account growth plan",
    agentSlug: "sales-account-strategist",
    summary: "Retention risks and expansion plays for an existing client.",
    effort: "medium",
    task: `This is an existing or soon-to-be client. Build a 90-day account plan: health assessment with risks, expansion opportunities that fit my offer, stakeholders to multi-thread with, a QBR agenda, and a month-by-month action list.`,
  },
  {
    id: "pipeline-review",
    label: "Pipeline review",
    agentSlug: "sales-pipeline-analyst",
    summary: "Where the pipeline is leaking and what to fix first.",
    effort: "medium",
    task: `Analyse my pipeline (data below). Report: coverage and weighted forecast, stage conversion and where deals stall, the deals most at risk and why, deals to push this week, and the 3 process changes with the biggest impact. Use numbers from the data.`,
  },
  {
    id: "ads-review",
    label: "Ad performance review",
    agentSlug: "paid-media-paid-social-strategist",
    summary: "What to scale, cut and test next across your Meta campaigns.",
    effort: "medium",
    task: `Review my Meta ad account (data below), including what the CRM shows these leads turned into. Report: overall health in 3 bullets, campaigns to scale / fix / pause with the reason from the numbers, the cost per lead and cost per customer I should target given my pricing, 3 creative or audience tests to run next, and any tracking gaps that make the numbers unreliable. Use the numbers; don't invent ones that aren't there.`,
  },
  {
    id: "prospect-pitch",
    label: "Prospect angle",
    agentSlug: "sales-offer-lead-gen-strategist",
    summary: "Why this business needs you, and the opener that proves it.",
    effort: "low",
    task: `This is a business I found while prospecting (data and website audit below). Tell me: whether it fits my ideal client and why, the strongest pain angle the audit reveals, a 2-sentence personalised opener for a call, and a 3-touch outreach sequence (call, email, SMS) with copy.`,
  },
];

function profileBlock(p: BusinessProfile): string {
  const rows = [
    ["Agency / business", p.agencyName],
    ["My name", p.yourName],
    ["What I sell", p.offer],
    ["Ideal client", p.idealClient],
    ["Price range", p.priceRange],
    ["Differentiators", p.differentiators],
    ["Booking link", p.bookingLink],
    ["Area I serve", p.area],
  ].filter(([, v]) => v);
  return rows.length ? rows.map(([k, v]) => `- ${k}: ${v}`).join("\n") : "- (No business profile set yet — keep recommendations general and tell me what to fill in under Settings → Business profile.)";
}

function systemPrompt(agent: Agent): string {
  const s = getSettings();
  return `${agent.body}

---
You are working inside Bloom AI, the user's client command center connected to their CRM (GoHighLevel). The user is an operator who sells services to the clients in their CRM.

About the user's business:
${profileBlock(s.profile)}

Ground every answer in the client data the user provides. If something important is unknown, say so in one line rather than guessing. Write in clean Markdown with short sections; the user reads this on screen, often right before or during a call.`;
}

export function claudeClient(): Anthropic | null {
  const s = getSettings();
  return s.anthropicApiKey ? new Anthropic({ apiKey: s.anthropicApiKey }) : null;
}

function sse(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export interface RunInput {
  agentSlug: string;
  messages: { role: "user" | "assistant"; content: string }[];
  effort?: "low" | "medium" | "high";
}

/** Streams a Claude response as server-sent events: `delta`, then `done` or `error`. */
export async function streamAgent(res: Response, input: RunInput): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const client = claudeClient();
  const agent = getAgent(input.agentSlug);
  if (!client) {
    sse(res, "error", { message: "Claude isn't connected. Add your Anthropic API key in Settings to run agents." });
    return void res.end();
  }
  if (!agent) {
    sse(res, "error", { message: `Agent "${input.agentSlug}" was not found in the repo.` });
    return void res.end();
  }

  const s = getSettings();
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  try {
    const stream = client.beta.messages.stream(
      {
        model: s.claudeModel || "claude-opus-5-5",
        max_tokens: 16000,
        system: [{ type: "text", text: systemPrompt(agent), cache_control: { type: "ephemeral" } }],
        messages: input.messages,
        output_config: { effort: input.effort ?? "medium" },
        // If a safety classifier declines, let the API re-route the same request instead of failing.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { signal: abort.signal },
    );
    sse(res, "meta", { agent: agent.name, model: s.claudeModel });
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        sse(res, "delta", { text: event.delta.text });
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      sse(res, "error", { message: "Claude declined this request. Try rephrasing it." });
    } else {
      sse(res, "done", { stopReason: final.stop_reason, usage: final.usage });
    }
  } catch (err) {
    if (abort.signal.aborted) return void res.end();
    let message = "Claude request failed.";
    if (err instanceof Anthropic.AuthenticationError) message = "Anthropic rejected the API key. Check it in Settings.";
    else if (err instanceof Anthropic.NotFoundError) message = `Model "${s.claudeModel}" isn't available on this API key. Pick another model in Settings.`;
    else if (err instanceof Anthropic.RateLimitError) message = "Rate limited by Anthropic — wait a moment and try again.";
    else if (err instanceof Anthropic.APIError) message = `Anthropic API error ${err.status ?? ""}: ${err.message}`;
    else if (err instanceof Error) message = err.message;
    sse(res, "error", { message });
  }
  res.end();
}

export const CHANNEL_LABEL: Record<string, string> = { SMS: "text message", Email: "email", FB: "Facebook Messenger message", IG: "Instagram DM", WhatsApp: "WhatsApp message" };
const LENGTH: Record<string, string> = { SMS: "under 300 characters", Email: "under 140 words", FB: "under 450 characters", IG: "under 450 characters", WhatsApp: "under 450 characters" };

export interface GenerateInput {
  agentSlug?: string;
  contact: Contact;
  history: Message[];
  channel: string;
  instructions: string;
  purpose: "outreach" | "reply";
}

/**
 * Writes one outbound message. Returns the text, or { handoff: true } when the
 * model decides a human should take over. Returns null when Claude isn't connected.
 */
export async function generateMessage(input: GenerateInput): Promise<{ text: string; handoff: boolean } | null> {
  const client = claudeClient();
  if (!client) return null;
  const s = getSettings();
  const agent = getAgent(input.agentSlug || "sales-outreach") ?? getAgent("sales-outreach");
  const label = CHANNEL_LABEL[input.channel] ?? "message";
  const p = s.profile;
  const system = `${agent?.body ?? ""}

---
You write messages that Bloom AI sends automatically on behalf of the business below. Each response is exactly one ${label} and is sent as-is, with no human review.

About the business:
${profileBlock(p)}

Rules:
- Output only the message text. No quotes, no labels, no sign-off placeholders, no [brackets].
- Keep it ${LENGTH[input.channel] ?? "short"}. Plain, warm, human language — it should read like ${p.yourName || "a real person"} typed it on their phone.
- Ground it in the conversation and contact details. Never invent prices, discounts, guarantees, availability or results that aren't in the business profile.
- One clear next step per message (usually a question or the booking link if one is set).
- If the person asks to stop or unsubscribe, is upset or complaining, asks for something you can't answer from the business profile, or asks for a human, output exactly HANDOFF and nothing else.`;

  const history = [...input.history]
    .sort((a, b) => a.dateAdded.localeCompare(b.dateAdded))
    .slice(-14)
    .map((m) => `[${new Date(m.dateAdded).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}] ${m.direction === "inbound" ? "Them" : "Us"} (${m.channel}): ${m.body.replace(/\s+/g, " ").slice(0, 600)}`)
    .join("\n");
  const c = input.contact;
  const user = `Contact: ${c.name}${c.companyName && c.companyName !== c.name ? ` at ${c.companyName}` : ""}${c.city ? ` (${c.city}${c.state ? `, ${c.state}` : ""})` : ""}. Source: ${c.source || "unknown"}. Tags: ${c.tags.join(", ") || "none"}.

Conversation so far (oldest first):
${history || "(no messages yet — this is the first touch)"}

Task: ${input.purpose === "reply" ? "Reply to their latest message. " : ""}${input.instructions || "Write the next message."}`;

  const res = await client.beta.messages.create({
    model: s.claudeModel || "claude-opus-5-5",
    max_tokens: 2048,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
    output_config: { effort: "low" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  if (res.stop_reason === "refusal") return { text: "", handoff: true };
  const text = res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim()
    .replace(/^["“]|["”]$/g, "");
  if (!text || /^HANDOFF\b/i.test(text)) return { text: "", handoff: true };
  return { text, handoff: false };
}

export async function testClaude(apiKey: string, model: string): Promise<string> {
  const client = new Anthropic({ apiKey });
  const m = await client.models.retrieve(model);
  return m.display_name;
}
