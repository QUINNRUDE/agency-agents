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

/** The demo workspace when it is the active CRM (for demo-only helpers such as simulated inbound messages). */
export function activeDemo(): DemoCrm | null {
  return crm() === demo ? demo : null;
}

/** Sample data (the demo business, sample ad numbers, sample prospects) is shown until the user removes it. */
export function demoDataOn(): boolean {
  return demo.isSample();
}

/** The local workspace, for starting fresh or loading the sample business again. */
export const localWorkspace = demo;
