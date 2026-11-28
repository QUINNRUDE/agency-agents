// Settings: values from .env win; anything else is edited from the Settings page
// and saved to data/settings.json (local to this machine, never sent anywhere
// except the service each key belongs to).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonFile } from "./store.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(here, "..", ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

export interface BusinessProfile {
  agencyName: string;
  yourName: string;
  offer: string; // what you sell
  idealClient: string; // who you sell to
  priceRange: string;
  differentiators: string;
  bookingLink: string;
  area: string; // where you look for clients, e.g. "Austin, TX" (Find clients starts here)
}

export interface Settings {
  ghlApiKey: string;
  ghlLocationId: string;
  anthropicApiKey: string;
  claudeModel: string;
  googlePlacesApiKey: string;
  apifyToken: string; // Apify (free plan: $5 of usage a month) runs the Google Maps lead finder
  defaultPipelineId: string;
  metaAccessToken: string;
  metaAdAccountId: string; // act_123…
  metaPageId: string;
  metaAutoSync: string; // "on" | "off" — pull new lead-form leads into the CRM every few minutes
  metaGraphVersion: string;
  callGoal: string; // daily dial goal shown on the overview
  profile: BusinessProfile;
}

const defaults: Settings = {
  ghlApiKey: "",
  ghlLocationId: "",
  anthropicApiKey: "",
  claudeModel: "claude-opus-5-5",
  googlePlacesApiKey: "",
  apifyToken: "",
  defaultPipelineId: "",
  metaAccessToken: "",
  metaAdAccountId: "",
  metaPageId: "",
  metaAutoSync: "off",
  metaGraphVersion: "v23.0",
  callGoal: "20",
  profile: {
    agencyName: "",
    yourName: "",
    offer: "",
    idealClient: "",
    priceRange: "",
    differentiators: "",
    bookingLink: "",
    area: "",
  },
};

const file = new JsonFile<Partial<Settings>>("settings.json", () => ({}));

const ENV_MAP: Partial<Record<keyof Settings, string>> = {
  ghlApiKey: "GHL_API_KEY",
  ghlLocationId: "GHL_LOCATION_ID",
  anthropicApiKey: "ANTHROPIC_API_KEY",
  claudeModel: "CLAUDE_MODEL",
  googlePlacesApiKey: "GOOGLE_PLACES_API_KEY",
  apifyToken: "APIFY_TOKEN",
  metaAccessToken: "META_ACCESS_TOKEN",
  metaAdAccountId: "META_AD_ACCOUNT_ID",
  metaPageId: "META_PAGE_ID",
  metaGraphVersion: "META_GRAPH_VERSION",
};

export function getSettings(): Settings {
  const saved = file.read();
  const merged: Settings = {
    ...defaults,
    ...saved,
    profile: { ...defaults.profile, ...(saved.profile ?? {}) },
  };
  for (const [key, envName] of Object.entries(ENV_MAP) as [keyof Settings, string][]) {
    const v = process.env[envName];
    if (v) (merged as unknown as Record<string, unknown>)[key] = v;
  }
  return merged;
}

export function envLocked(): (keyof Settings)[] {
  return (Object.entries(ENV_MAP) as [keyof Settings, string][])
    .filter(([, env]) => Boolean(process.env[env]))
    .map(([k]) => k);
}

const SECRET_KEYS = ["ghlApiKey", "anthropicApiKey", "googlePlacesApiKey", "apifyToken", "metaAccessToken"] as const;

function mask(v: string): string {
  if (!v) return "";
  return v.length <= 8 ? "••••" : `${v.slice(0, 4)}••••${v.slice(-4)}`;
}

/** Settings as the browser may see them: secrets masked. */
export function publicSettings() {
  const s = getSettings();
  return {
    ...s,
    ghlApiKey: mask(s.ghlApiKey),
    anthropicApiKey: mask(s.anthropicApiKey),
    googlePlacesApiKey: mask(s.googlePlacesApiKey),
    apifyToken: mask(s.apifyToken),
    metaAccessToken: mask(s.metaAccessToken),
    has: {
      ghl: Boolean(s.ghlApiKey && s.ghlLocationId),
      claude: Boolean(s.anthropicApiKey),
      places: Boolean(s.googlePlacesApiKey),
      apify: Boolean(s.apifyToken),
      meta: Boolean(s.metaAccessToken && s.metaAdAccountId),
    },
    envLocked: envLocked(),
  };
}

export function saveSettings(patch: Partial<Settings>): void {
  file.update((draft) => {
    for (const [k, v] of Object.entries(patch)) {
      if (k === "profile" && v && typeof v === "object") {
        draft.profile = { ...defaults.profile, ...(draft.profile ?? {}), ...(v as Partial<BusinessProfile>) };
        continue;
      }
      if (typeof v !== "string") continue;
      // A masked value coming back from the form means "unchanged".
      if ((SECRET_KEYS as readonly string[]).includes(k) && v.includes("••••")) continue;
      (draft as Record<string, unknown>)[k] = v.trim();
    }
  });
}
