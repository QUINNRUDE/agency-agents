/** RFC 4180-style CSV parser: quoted fields, escaped quotes, embedded newlines, ; or , or tab delimiters. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = [",", ";", "\t"].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows.map((r) => r.map((c) => c.trim()));
}

export const IMPORT_FIELDS = [
  { key: "firstName", label: "First name", match: /^(first|first.?name|given)/i },
  { key: "lastName", label: "Last name", match: /^(last|last.?name|surname|family)/i },
  { key: "fullName", label: "Full name (split)", match: /^(name|full.?name|contact.?name|contact)$/i },
  { key: "email", label: "Email", match: /e.?mail/i },
  { key: "phone", label: "Phone", match: /(phone|mobile|cell|tel)/i },
  { key: "companyName", label: "Company", match: /(company|business|organi[sz]ation|account)/i },
  { key: "website", label: "Website", match: /(website|url|domain|site)/i },
  { key: "city", label: "City", match: /^(city|town)/i },
  { key: "state", label: "State", match: /^(state|province|region)/i },
  { key: "source", label: "Source", match: /(source|lead.?source)/i },
  { key: "tags", label: "Tags (comma separated)", match: /^tags?$/i },
] as const;

export type ImportKey = (typeof IMPORT_FIELDS)[number]["key"];

export function guessMapping(headers: string[]): Record<number, ImportKey | ""> {
  const used = new Set<string>();
  const out: Record<number, ImportKey | ""> = {};
  headers.forEach((h, i) => {
    const f = IMPORT_FIELDS.find((x) => !used.has(x.key) && x.match.test(h.trim()));
    out[i] = f ? f.key : "";
    if (f) used.add(f.key);
  });
  return out;
}
