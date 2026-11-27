import { getSettings } from "../config.ts";
import { DemoCrm } from "./demo.ts";
import { GhlCrm } from "./ghl.ts";
import type { Crm } from "./types.ts";

const demo = new DemoCrm();
let live: { key: string; crm: GhlCrm } | null = null;

/** The active CRM: GoHighLevel when a token + location are configured, otherwise the local demo workspace. */
export function crm(): Crm {
  const s = getSettings();
  if (!s.ghlApiKey || !s.ghlLocationId) return demo;
  const key = `${s.ghlApiKey}:${s.ghlLocationId}`;
  if (!live || live.key !== key) live = { key, crm: new GhlCrm(s.ghlApiKey, s.ghlLocationId) };
  return live.crm;
}

export function testGhl(token: string, locationId: string) {
  return new GhlCrm(token, locationId).info();
}
