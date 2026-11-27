// Campaign builder: creates a complete Meta lead-ad campaign (campaign → ad set →
// image → lead form → creative → ad) through the Marketing API, for your own ad
// account or a client's. Everything is created paused unless the caller asks to
// launch, and a failed step cleans up the half-built campaign.
import Anthropic from "@anthropic-ai/sdk";
import { claudeClient } from "./ai.ts";
import { getAgent } from "./agents.ts";
import { getSettings } from "./config.ts";
import { actId, arr, graph, minorFactor, MetaError, num, obj, pageToken, sampleDrafts, str, TEXT_CONSENT_KEY, type Json } from "./meta.ts";
import { CTAS, SAMPLE_PLACES, templateCopy, type AdLocation, type CopyInput, type CopyVariant, type Cta } from "./adTemplates.ts";

export { CTAS, templateCopy, type AdLocation, type CopyInput, type CopyVariant, type Cta };

const isCta = (v: unknown): v is Cta => typeof v === "string" && v in CTAS;


export interface NewForm {
  name: string;
  /** Optional extra question, e.g. "What do you need help with?" */
  question: string;
  /** Adds "Can we text you about your request?" so texting consent comes in with the lead. */
  askTextConsent: boolean;
  privacyUrl: string;
  websiteUrl: string;
}

export interface NewCampaign {
  name: string;
  adAccountId: string;
  pageId: string;
  /** Instagram account to also run on. Empty = Facebook only. */
  instagramId: string;
  /** Empty = the whole United States. */
  locations: AdLocation[];
  ageMin: number;
  ageMax: number;
  primaryText: string;
  headline: string;
  description: string;
  cta: Cta;
  image: { base64: string; filename: string } | { hash: string };
  form: { id: string } | { create: NewForm };
  dailyBudget: number;
  launch: boolean;
}

const httpsUrl = (v: string) => {
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
};

/** Reads and checks a request body. Returns the input, or the list of problems to fix. */
export function parseCampaign(body: unknown): { ok: true; input: NewCampaign } | { ok: false; errors: string[] } {
  const b = obj(body);
  const errors: string[] = [];
  const text = (k: string, max: number) => str(b[k]).trim().slice(0, max);
  const name = text("name", 200);
  if (!name) errors.push("Give the campaign a name.");
  const pageId = text("pageId", 40);
  if (!pageId) errors.push("Pick the Facebook Page the ad runs from.");
  const locations: AdLocation[] = arr(b.locations)
    .map(obj)
    .filter((l) => str(l.key) && ["city", "zip", "region"].includes(str(l.type)))
    .slice(0, 50)
    .map((l) => ({
      key: str(l.key),
      name: str(l.name),
      type: str(l.type) as AdLocation["type"],
      detail: str(l.detail),
      radius: str(l.type) === "city" ? Math.min(50, Math.max(10, num(l.radius) || 15)) : undefined,
    }));
  const ageMin = Math.min(65, Math.max(18, Math.round(num(b.ageMin) || 25)));
  const ageMax = Math.min(65, Math.max(ageMin, Math.round(num(b.ageMax) || 65)));
  const primaryText = text("primaryText", 2000);
  const headline = text("headline", 255);
  const description = text("description", 255);
  if (!primaryText) errors.push("Write the ad's main text.");
  if (!headline) errors.push("Add a headline.");
  const cta: Cta = isCta(b.cta) ? b.cta : "GET_QUOTE";

  const img = obj(b.image);
  let image: NewCampaign["image"] | null = null;
  if (str(img.hash)) image = { hash: str(img.hash) };
  else if (str(img.base64)) {
    const base64 = str(img.base64).replace(/^data:image\/[a-z+]+;base64,/i, "");
    if (base64.length > 11_000_000) errors.push("The image is too big. Use one under 8 MB.");
    image = { base64, filename: str(img.filename).replace(/[^\w.-]/g, "_").slice(0, 80) || "ad.jpg" };
  }
  if (!image) errors.push("Add an image for the ad.");

  const f = obj(b.form);
  let form: NewCampaign["form"] | null = null;
  if (str(f.id)) form = { id: str(f.id) };
  else {
    const c = obj(f.create);
    const create: NewForm = {
      name: str(c.name).trim().slice(0, 200) || `${name || "Lead form"}`.slice(0, 200),
      question: str(c.question).trim().slice(0, 200),
      askTextConsent: c.askTextConsent !== false,
      privacyUrl: str(c.privacyUrl).trim(),
      websiteUrl: str(c.websiteUrl).trim(),
    };
    if (!httpsUrl(create.privacyUrl)) errors.push("Meta requires a link to the business's privacy policy on the lead form.");
    if (create.websiteUrl && !httpsUrl(create.websiteUrl)) errors.push("The website link on the thank-you screen isn't a valid web address.");
    form = { create };
  }

  const dailyBudget = Math.round(num(b.dailyBudget) * 100) / 100;
  if (dailyBudget < 1) errors.push("Set a daily budget of at least $1.");
  if (dailyBudget > 10_000) errors.push("That daily budget is over $10,000. Set big budgets in Meta Ads Manager.");
  if (b.specialCategory === true) errors.push("Ads about housing, jobs, credit or politics have special rules. Create those in Meta Ads Manager.");

  if (errors.length || !image || !form) return { ok: false, errors };
  return {
    ok: true,
    input: { name, adAccountId: text("adAccountId", 40), pageId, instagramId: text("instagramId", 40), locations, ageMin, ageMax, primaryText, headline, description, cta, image, form, dailyBudget, launch: b.launch === true },
  };
}

// ---- Accounts, Pages, locations -------------------------------------------------

export interface AdAssets {
  connected: boolean;
  adAccounts: { id: string; name: string; currency: string; active: boolean }[];
  pages: { id: string; name: string; instagram: { id: string; username: string } | null }[];
  defaults: { adAccountId: string; pageId: string };
}

export async function adAssets(): Promise<AdAssets> {
  const s = getSettings();
  if (!s.metaAccessToken) {
    return {
      connected: false,
      adAccounts: [{ id: "act_sample", name: "Sample ad account", currency: "USD", active: true }],
      pages: [{ id: "sample_page", name: s.profile.agencyName || "Your business", instagram: { id: "sample_ig", username: "yourbusiness" } }],
      defaults: { adAccountId: "act_sample", pageId: "sample_page" },
    };
  }
  const [accounts, pages] = await Promise.all([
    graph<Json>("me/adaccounts", { fields: "id,name,currency,account_status", limit: "100" }),
    graph<Json>("me/accounts", { fields: "id,name,instagram_business_account{id,username}", limit: "100" }).catch(() => ({ data: [] }) as Json),
  ]);
  const adAccounts = arr(accounts.data).map(obj).map((a) => ({ id: str(a.id), name: str(a.name), currency: str(a.currency) || "USD", active: num(a.account_status) === 1 }));
  return {
    connected: true,
    adAccounts,
    pages: arr(pages.data)
      .map(obj)
      .map((p) => {
        const ig = obj(p.instagram_business_account);
        return { id: str(p.id), name: str(p.name), instagram: str(ig.id) ? { id: str(ig.id), username: str(ig.username) } : null };
      }),
    defaults: { adAccountId: s.metaAdAccountId ? actId(s.metaAdAccountId) : (adAccounts[0]?.id ?? ""), pageId: s.metaPageId },
  };
}


/** Cities, states and ZIP codes Meta can target, matching what the user typed. */
export async function searchLocations(q: string): Promise<AdLocation[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  if (!getSettings().metaAccessToken) {
    const t = term.toLowerCase();
    return SAMPLE_PLACES.filter((p) => p.name.toLowerCase().startsWith(t) || p.detail.toLowerCase().includes(t)).slice(0, 8);
  }
  const data = await graph<Json>("search", { type: "adgeolocation", q: term, location_types: JSON.stringify(["city", "region", "zip"]), limit: "10" });
  return arr(data.data)
    .map(obj)
    .filter((l) => ["city", "region", "zip"].includes(str(l.type)) && (!str(l.country_code) || str(l.country_code) === "US"))
    .map((l) => ({
      key: str(l.key),
      name: str(l.name),
      type: str(l.type) as AdLocation["type"],
      detail: [str(l.type) === "zip" ? str(l.primary_city) : "", str(l.region), str(l.country_name) || "United States"].filter(Boolean).join(", "),
    }));
}

// ---- Building the campaign --------------------------------------------------------

/** Targeting spec for the ad set. Meta's Advantage+ audience is off so the age range is a hard limit. */
export function targetingSpec(input: Pick<NewCampaign, "locations" | "ageMin" | "ageMax" | "instagramId">): Json {
  const geo: Json = {};
  const cities = input.locations.filter((l) => l.type === "city");
  const regions = input.locations.filter((l) => l.type === "region");
  const zips = input.locations.filter((l) => l.type === "zip");
  if (cities.length) geo.cities = cities.map((c) => ({ key: c.key, radius: c.radius ?? 15, distance_unit: "mile" }));
  if (regions.length) geo.regions = regions.map((r) => ({ key: r.key }));
  if (zips.length) geo.zips = zips.map((z) => ({ key: z.key }));
  if (!Object.keys(geo).length) geo.countries = ["US"];
  return {
    geo_locations: geo,
    age_min: input.ageMin,
    age_max: input.ageMax,
    publisher_platforms: input.instagramId ? ["facebook", "instagram"] : ["facebook"],
    targeting_automation: { advantage_audience: 0 },
  };
}

export function formQuestions(f: NewForm): Json[] {
  const q: Json[] = [{ type: "FULL_NAME" }, { type: "EMAIL" }, { type: "PHONE" }];
  if (f.question) q.push({ type: "CUSTOM", key: "details", label: f.question });
  if (f.askTextConsent)
    q.push({
      type: "CUSTOM",
      key: TEXT_CONSENT_KEY,
      label: "Can we text you about your request?",
      options: [
        { key: "yes", value: "Yes, text me" },
        { key: "no", value: "No texts, please" },
      ],
    });
  return q;
}

async function uploadImage(act: string, image: NewCampaign["image"]): Promise<string> {
  if ("hash" in image) return image.hash;
  const res = await graph<Json>(`${act}/adimages`, { bytes: image.base64, name: image.filename }, { method: "POST" });
  const first = obj(Object.values(obj(res.images))[0]);
  const hash = str(first.hash);
  if (!hash) throw new MetaError("Meta didn't accept the image. Try a JPG or PNG, at least 1080 × 1080.", 400);
  return hash;
}

async function createForm(pageId: string, f: NewForm): Promise<string> {
  const token = await pageToken(pageId);
  const params: Record<string, string> = {
    name: f.name,
    questions: JSON.stringify(formQuestions(f)),
    privacy_policy: JSON.stringify({ url: f.privacyUrl, link_text: "Privacy policy" }),
  };
  if (f.websiteUrl) params.follow_up_action_url = f.websiteUrl;
  const res = await graph<Json>(`${pageId}/leadgen_forms`, params, { method: "POST", token });
  if (!str(res.id)) throw new MetaError("Meta didn't return the new lead form.", 502);
  return str(res.id);
}

export interface CreateResult {
  sample: boolean;
  campaignId: string;
  adSetId: string;
  adId: string;
  formId: string;
  status: "ACTIVE" | "PAUSED";
}

export async function createCampaign(input: NewCampaign): Promise<CreateResult> {
  const s = getSettings();
  if (!s.metaAccessToken) {
    // Sample mode: show the campaign in the list so the flow can be tried end to end.
    const id = `sample_new_${sampleDrafts.length + 1}`;
    sampleDrafts.unshift({ id, name: input.name, status: "PAUSED", effectiveStatus: "PAUSED", objective: "leads", dailyBudget: input.dailyBudget, lifetimeBudget: null, spend: 0, impressions: 0, clicks: 0, ctr: 0, cpm: 0, leads: 0, cpl: null });
    return { sample: true, campaignId: id, adSetId: "", adId: "", formId: "", status: "PAUSED" };
  }
  const act = actId(input.adAccountId || s.metaAdAccountId);
  if (act === "act_") throw new MetaError("Pick the ad account to run this campaign in.", 400);
  const account = await graph<Json>(act, { fields: "currency" });
  const budget = Math.round(input.dailyBudget * minorFactor(str(account.currency) || "USD"));

  // Image and form first: they are the steps most likely to be rejected, and nothing has been created yet.
  const imageHash = await uploadImage(act, input.image);
  const formId = "id" in input.form ? input.form.id : await createForm(input.pageId, input.form.create);

  const campaign = await graph<Json>(
    `${act}/campaigns`,
    {
      name: input.name,
      objective: "OUTCOME_LEADS",
      status: "PAUSED",
      special_ad_categories: "[]",
      buying_type: "AUCTION",
      daily_budget: String(budget),
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    },
    { method: "POST" },
  );
  const campaignId = str(campaign.id);
  try {
    const adSet = await graph<Json>(
      `${act}/adsets`,
      {
        name: `${input.name} · ad set`,
        campaign_id: campaignId,
        optimization_goal: "LEAD_GENERATION",
        billing_event: "IMPRESSIONS",
        destination_type: "ON_AD",
        promoted_object: JSON.stringify({ page_id: input.pageId }),
        targeting: JSON.stringify(targetingSpec(input)),
        status: "ACTIVE",
      },
      { method: "POST" },
    );
    const linkData: Json = {
      image_hash: imageHash,
      link: "http://fb.me/",
      message: input.primaryText,
      name: input.headline,
      call_to_action: { type: input.cta, value: { lead_gen_form_id: formId } },
    };
    if (input.description) linkData.description = input.description;
    const story: Json = { page_id: input.pageId, link_data: linkData };
    if (input.instagramId) story.instagram_user_id = input.instagramId;
    const creative = await graph<Json>(`${act}/adcreatives`, { name: `${input.name} · creative`, object_story_spec: JSON.stringify(story) }, { method: "POST" });
    const ad = await graph<Json>(
      `${act}/ads`,
      { name: `${input.name} · ad`, adset_id: str(adSet.id), creative: JSON.stringify({ creative_id: str(creative.id) }), status: "ACTIVE" },
      { method: "POST" },
    );
    // The campaign is the one switch: ad set and ad are on, so turning it on starts delivery after Meta's review.
    if (input.launch) await graph(campaignId, { status: "ACTIVE" }, { method: "POST" });
    return { sample: false, campaignId, adSetId: str(adSet.id), adId: str(ad.id), formId, status: input.launch ? "ACTIVE" : "PAUSED" };
  } catch (err) {
    // Don't leave a half-built campaign behind. Deleting the campaign removes anything under it.
    await graph(campaignId, {}, { method: "DELETE" }).catch(() => undefined);
    throw err;
  }
}

// ---- Ad copy ------------------------------------------------------------------------

const COPY_SCHEMA = {
  type: "object",
  properties: {
    variants: {
      type: "array",
      items: {
        type: "object",
        properties: {
          angle: { type: "string" },
          primaryText: { type: "string" },
          headline: { type: "string" },
          description: { type: "string" },
        },
        required: ["angle", "primaryText", "headline", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["variants"],
  additionalProperties: false,
};

/** Three lead-ad copy variants from the repo's Paid Media Creative Strategist. */
export async function writeAdCopy(i: CopyInput): Promise<{ ai: boolean; variants: CopyVariant[] }> {
  const client = claudeClient();
  if (!client) return { ai: false, variants: templateCopy(i) };
  const s = getSettings();
  const agent = getAgent("paid-media-creative-strategist") ?? getAgent("paid-media-paid-social-strategist");
  const system = `${agent?.body ?? ""}

---
You write Facebook and Instagram lead-ad copy that Bloom AI puts straight into a Meta campaign. The advertiser is a local business.

Rules:
- Exactly 3 variants, each from a different angle (for example: the offer, the problem it solves, who it's for). Name the angle in 2 to 4 words.
- primaryText: 1 to 3 short sentences, under 300 characters, plain and specific. The first sentence must work alone, since Meta cuts the rest behind "See more".
- headline: under 40 characters. description: under 30 characters.
- End primaryText by pointing to the button ("${CTAS[i.cta]}").
- Only use facts given below. Never invent prices, discounts, deadlines, reviews, years in business, guarantees or results.
- Meta's ad policies apply: don't call out personal attributes ("Are you overweight?", "your debt"), no all caps, no fake urgency, no clickbait.`;
  const user = `Business: ${i.business || "(not given)"}
Offer: ${i.offer || "(not given)"}
Who it's for: ${i.audience || "(not given)"}
Area: ${i.place || "(not given)"}
Notes from the advertiser: ${i.notes || "(none)"}`;
  try {
    const res = await client.beta.messages.create({
      model: s.claudeModel || "claude-opus-5-5",
      max_tokens: 4096,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
      output_config: { effort: "low", format: { type: "json_schema", schema: COPY_SCHEMA } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (res.stop_reason === "refusal") throw new MetaError("Claude declined to write this ad. Try describing the offer differently.", 422);
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const variants = arr(obj(JSON.parse(text)).variants)
      .map(obj)
      .map((v) => ({ angle: str(v.angle), primaryText: str(v.primaryText), headline: str(v.headline).slice(0, 255), description: str(v.description).slice(0, 255) }))
      .filter((v) => v.primaryText && v.headline)
      .slice(0, 3);
    if (!variants.length) throw new MetaError("Claude didn't return usable ad copy. Try again.", 502);
    return { ai: true, variants };
  } catch (err) {
    if (err instanceof MetaError) throw err;
    if (err instanceof Anthropic.AuthenticationError) throw new MetaError("Anthropic rejected the API key. Check it in Settings.", 401);
    if (err instanceof Anthropic.RateLimitError) throw new MetaError("Rate limited by Anthropic. Wait a moment and try again.", 429);
    if (err instanceof Anthropic.APIError) throw new MetaError(`Anthropic API error ${err.status ?? ""}: ${err.message}`, 502);
    throw err;
  }
}
