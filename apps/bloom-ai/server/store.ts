// Tiny JSON-file persistence. Everything the app owns locally (settings, call
// logs, prospect lists, and the demo CRM) lives in ./data so it survives restarts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.BLOOM_DATA_DIR ? path.resolve(process.env.BLOOM_DATA_DIR) : path.resolve(here, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export class JsonFile<T> {
  private cache: T | null = null;
  private file: string;
  constructor(
    name: string,
    private fallback: () => T,
  ) {
    this.file = path.join(DATA_DIR, name);
  }

  read(): T {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(fs.readFileSync(this.file, "utf8")) as T;
    } catch {
      this.cache = this.fallback();
      this.write(this.cache);
    }
    return this.cache;
  }

  write(value: T): void {
    this.cache = value;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, this.file);
  }

  update(fn: (draft: T) => void): T {
    const value = this.read();
    fn(value);
    this.write(value);
    return value;
  }
}

let counter = 0;
export function uid(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// ---- Locally owned records -------------------------------------------------

export type CallOutcome =
  | "connected"
  | "booked"
  | "voicemail"
  | "no_answer"
  | "callback"
  | "not_interested"
  | "wrong_number";

export interface CallLog {
  id: string;
  contactId: string;
  contactName: string;
  companyName: string;
  phone: string;
  outcome: CallOutcome;
  durationSec: number;
  notes: string;
  nextStep: string;
  followUpDate: string | null;
  startedAt: string;
  syncedToCrm: boolean;
}

export interface Prospect {
  id: string;
  placeId: string;
  name: string;
  category: string;
  address: string;
  city: string;
  phone: string;
  website: string;
  rating: number | null;
  reviews: number;
  mapsUrl: string;
  score: number;
  signals: string[];
  audit: SiteAudit | null;
  status: "new" | "added" | "dismissed";
  contactId: string | null;
  sample: boolean;
  foundAt: string;
  search: string;
  /** Where the lead came from. Missing on older records (Google Places or sample). */
  source?: "google" | "apify" | "osm" | "sample";
  email?: string;
  socials?: string[];
}

export interface SiteAudit {
  url: string;
  ok: boolean;
  statusCode: number | null;
  https: boolean;
  responseMs: number | null;
  title: string;
  metaDescription: boolean;
  mobileViewport: boolean;
  hasForm: boolean;
  hasClickToCall: boolean;
  bookingWidget: string | null;
  chatWidget: string | null;
  analytics: string[];
  copyrightYear: number | null;
  findings: { level: "good" | "warn" | "bad"; text: string }[];
  checkedAt: string;
  /** Contact details found on the site (homepage and contact page). Missing on older audits. */
  emails?: string[];
  phones?: string[];
  socials?: string[];
}

export interface SavedView {
  id: string;
  name: string;
  filters: Record<string, string>;
  createdAt: string;
}

export interface MetaLead {
  leadId: string;
  formId: string;
  formName: string;
  campaignName: string;
  adName: string;
  platform: string;
  createdAt: string;
  contactId: string;
  name: string;
  email: string;
  phone: string;
}

/** A lead search running on Apify, then a free contact scan of each lead's website. */
export interface LeadJob {
  id: string;
  niche: string;
  location: string;
  max: number;
  runId: string;
  datasetId: string;
  status: "scraping" | "finding-contacts" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  error: string;
  found: number;
  contactsToCheck: number;
  contactsChecked: number;
  emailsFound: number;
  prospectIds: string[];
  estimateUsd: number;
  costUsd: number | null;
}

export interface LocalDb {
  calls: CallLog[];
  prospects: Prospect[];
  views: SavedView[];
  metaLeads: MetaLead[];
  metaSync: { lastSyncAt: string; lastLeadTime: string; lastError: string };
  leadJobs: LeadJob[];
}

const localFile = new JsonFile<LocalDb>("local.json", () => ({ calls: [], prospects: [], views: [], metaLeads: [], metaSync: { lastSyncAt: "", lastLeadTime: "", lastError: "" }, leadJobs: [] }));
export const localDb = {
  read(): LocalDb {
    const d = localFile.read();
    d.views ??= [];
    d.metaLeads ??= [];
    d.metaSync ??= { lastSyncAt: "", lastLeadTime: "", lastError: "" };
    d.leadJobs ??= [];
    return d;
  },
  update(fn: (d: LocalDb) => void): LocalDb {
    const d = localDb.read();
    fn(d);
    localFile.write(d);
    return d;
  },
};
