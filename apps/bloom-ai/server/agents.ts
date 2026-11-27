// Indexes every agent in the Agency Agents repo (the directories listed in
// divisions.json at the repo root) so the app can run any of them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// apps/bloom-ai/server -> repo root. Override with AGENTS_DIR to point elsewhere.
export const REPO_ROOT = process.env.AGENTS_DIR ? path.resolve(process.env.AGENTS_DIR) : path.resolve(here, "..", "..", "..");

export interface AgentMeta {
  slug: string;
  name: string;
  description: string;
  emoji: string;
  color: string;
  vibe: string;
  division: string;
  divisionLabel: string;
  divisionColor: string;
  path: string;
}

export interface Agent extends AgentMeta {
  body: string;
}

function parseFrontmatter(src: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[>|][-+]?$/.test(value)) {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      value = parts.join(value.startsWith(">") ? " " : "\n");
    }
    meta[kv[1]] = value.replace(/^["'](.*)["']$/, "$1");
  }
  return { meta, body: src.slice(m[0].length) };
}

let index: Agent[] | null = null;

function load(): Agent[] {
  let divisions: Record<string, { label: string; color: string }> = {};
  try {
    divisions = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "divisions.json"), "utf8")).divisions ?? {};
  } catch {
    divisions = {};
  }
  const agents: Agent[] = [];
  const walk = (dir: string, division: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, division);
      else if (entry.name.endsWith(".md") && entry.name !== "README.md") {
        const { meta, body } = parseFrontmatter(fs.readFileSync(full, "utf8"));
        if (!meta.name) continue;
        const d = divisions[division] ?? { label: division, color: "#666666" };
        agents.push({
          slug: path.basename(entry.name, ".md"),
          name: meta.name,
          description: meta.description ?? "",
          emoji: meta.emoji ?? "",
          color: meta.color ?? d.color,
          vibe: meta.vibe ?? "",
          division,
          divisionLabel: d.label,
          divisionColor: d.color,
          path: path.relative(REPO_ROOT, full),
          body: body.trim(),
        });
      }
    }
  };
  for (const division of Object.keys(divisions)) {
    const dir = path.join(REPO_ROOT, division);
    if (fs.existsSync(dir)) walk(dir, division);
  }
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

export function allAgents(): Agent[] {
  if (!index) index = load();
  return index;
}

export function getAgent(slug: string): Agent | undefined {
  return allAgents().find((a) => a.slug === slug);
}

export function agentMeta(a: Agent): AgentMeta {
  const { body: _body, ...meta } = a;
  return meta;
}
