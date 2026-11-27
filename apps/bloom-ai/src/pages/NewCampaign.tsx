import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Check, CircleAlert, ImagePlus, MapPin, Rocket, Save, Search, Sparkles, X } from "lucide-react";
import { api } from "../lib/api.ts";
import { money } from "../lib/format.ts";
import { Banner, Card, Field, Skeleton, Spinner, useAsync, useToast } from "../components/ui.tsx";
import { ChannelIcon, Toggle } from "../components/brand.tsx";
import { ConfirmModal } from "../components/crm.tsx";
import { CTAS, type AdLocation as Place, type CopyVariant as Variant, type Cta } from "../../server/adTemplates.ts";

interface Assets {
  connected: boolean;
  adAccounts: { id: string; name: string; currency: string; active: boolean }[];
  pages: { id: string; name: string; instagram: { id: string; username: string } | null }[];
  defaults: { adAccountId: string; pageId: string };
}
interface LeadForm {
  id: string;
  name: string;
  status: string;
  leads: number;
}

const TYPE_LABEL: Record<Place["type"], string> = { city: "City", region: "State", zip: "ZIP" };
const MAX_IMAGE = 8 * 1024 * 1024;

function Step({ n, title, sub, children }: { n: number; title: string; sub?: string; children: React.ReactNode }) {
  return (
    <Card
      title={
        <span className="row" style={{ gap: 10 }}>
          <span className="step-num">{n}</span>
          {title}
        </span>
      }
      sub={sub}
    >
      <div className="stack">{children}</div>
    </Card>
  );
}

/** What the ad looks like in the Facebook feed. */
function AdPreview({ page, text, headline, description, cta, image }: { page: string; text: string; headline: string; description: string; cta: Cta; image: string }) {
  const [more, setMore] = useState(false);
  const long = text.length > 125;
  return (
    <div className="fb-ad" aria-label="Ad preview">
      <div className="fb-ad-head">
        <span className="fb-ad-avatar">{(page || "B").charAt(0).toUpperCase()}</span>
        <div>
          <div className="fb-ad-page">{page || "Your Page"}</div>
          <div className="fb-ad-sponsored">Sponsored</div>
        </div>
      </div>
      <div className="fb-ad-text">
        {text ? (long && !more ? `${text.slice(0, 125).trimEnd()}… ` : `${text} `) : <span className="faint">Your ad text shows here.</span>}
        {long && !more && <button className="link-btn" onClick={() => setMore(true)}>See more</button>}
      </div>
      <div className="fb-ad-image">{image ? <img src={image} alt="" /> : <span><ImagePlus /> 1080 × 1080 image</span>}</div>
      <div className="fb-ad-foot">
        <div style={{ minWidth: 0 }}>
          <div className="fb-ad-domain">Form on Facebook</div>
          <div className="fb-ad-headline ellipsis">{headline || "Your headline"}</div>
          {description && <div className="fb-ad-desc ellipsis">{description}</div>}
        </div>
        <span className="fb-ad-cta">{CTAS[cta]}</span>
      </div>
    </div>
  );
}

export function NewCampaign() {
  const toast = useToast();
  const navigate = useNavigate();
  const assets = useAsync(() => api.get<Assets>("/api/meta/assets"));
  const a = assets.data;

  // 1 · Basics
  const [name, setName] = useState("");
  const [adAccountId, setAdAccountId] = useState("");
  const [pageId, setPageId] = useState("");
  const [useInstagram, setUseInstagram] = useState(true);
  const [special, setSpecial] = useState(false);
  useEffect(() => {
    if (!a) return;
    setAdAccountId((v) => v || a.defaults.adAccountId || a.adAccounts[0]?.id || "");
    setPageId((v) => v || a.defaults.pageId || a.pages[0]?.id || "");
  }, [a]);
  const page = a?.pages.find((p) => p.id === pageId);
  const account = a?.adAccounts.find((x) => x.id === adAccountId);
  const instagram = page?.instagram ?? null;

  // 2 · Audience
  const [places, setPlaces] = useState<Place[]>([]);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [ageMin, setAgeMin] = useState(25);
  const [ageMax, setAgeMax] = useState(65);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return setHits([]);
    setSearching(true);
    const t = setTimeout(() => {
      api
        .get<Place[]>(`/api/meta/locations?q=${encodeURIComponent(term)}`)
        .then((r) => setHits(r.filter((h) => !places.some((p) => p.key === h.key))))
        .catch((e) => toast(e instanceof Error ? e.message : "Location search failed", "bad"))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const addPlace = (p: Place) => {
    setPlaces((list) => [...list, { ...p, radius: p.type === "city" ? 15 : undefined }]);
    setQ("");
    setHits([]);
  };

  // 3 · The ad
  const [image, setImage] = useState<{ dataUrl: string; filename: string; width: number; height: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [primaryText, setPrimaryText] = useState("");
  const [headline, setHeadline] = useState("");
  const [description, setDescription] = useState("");
  const [cta, setCta] = useState<Cta>("GET_QUOTE");
  const [offer, setOffer] = useState("");
  const [audience, setAudience] = useState("");
  const [notes, setNotes] = useState("");
  const [variants, setVariants] = useState<Variant[] | null>(null);
  const [writing, setWriting] = useState(false);
  const [aiUsed, setAiUsed] = useState(true);

  const readImage = (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(jpeg|png)$/.test(file.type)) return toast("Use a JPG or PNG image.", "bad");
    if (file.size > MAX_IMAGE) return toast("That image is over 8 MB. Export a smaller one.", "bad");
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const img = new Image();
      img.onload = () => setImage({ dataUrl, filename: file.name, width: img.naturalWidth, height: img.naturalHeight });
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  };

  // Name the area the way a person would: cities and states first, ZIP codes only if that's all there is.
  const named = places.filter((p) => p.type !== "zip");
  const placeLabel = (named.length ? named : places).map((p) => p.name).slice(0, 2).join(" and ");
  const writeCopy = async () => {
    setWriting(true);
    try {
      const r = await api.post<{ ai: boolean; variants: Variant[] }>("/api/meta/ad-copy", { business: page?.name ?? "", offer, audience, place: placeLabel, notes, cta });
      setVariants(r.variants);
      setAiUsed(r.ai);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't write the ad", "bad");
    } finally {
      setWriting(false);
    }
  };
  const pickVariant = (v: Variant) => {
    setPrimaryText(v.primaryText);
    setHeadline(v.headline);
    setDescription(v.description);
  };

  // 4 · Lead form
  const forms = useAsync(() => (a?.connected && pageId ? api.get<LeadForm[]>(`/api/meta/forms?page=${encodeURIComponent(pageId)}`) : Promise.resolve([] as LeadForm[])), [a?.connected, pageId]);
  const [formMode, setFormMode] = useState<"new" | "existing">("new");
  const [formId, setFormId] = useState("");
  const [formName, setFormName] = useState("");
  const [question, setQuestion] = useState("What do you need help with?");
  const [askText, setAskText] = useState(true);
  const [privacyUrl, setPrivacyUrl] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  useEffect(() => {
    if (formMode === "existing" && !formId && forms.data?.length) setFormId(forms.data[0].id);
  }, [formMode, formId, forms.data]);

  // 5 · Budget
  const [budget, setBudget] = useState("20");
  const daily = Number(budget.replace(/[^\d.]/g, "")) || 0;
  const cur = account?.currency ?? "USD";
  const m = (n: number) => (cur === "USD" ? money(n) : `${cur} ${n.toFixed(2)}`);
  const [confirm, setConfirm] = useState<"launch" | null>(null);
  const [busy, setBusy] = useState(false);

  const missing = useMemo(() => {
    const out: string[] = [];
    if (!name.trim()) out.push("Campaign name");
    if (!pageId) out.push("Facebook Page");
    if (special) out.push("Special ad categories go through Meta Ads Manager");
    if (!image) out.push("Ad image");
    if (!primaryText.trim()) out.push("Ad text");
    if (!headline.trim()) out.push("Headline");
    if (formMode === "existing" && !formId) out.push("Lead form");
    if (formMode === "new" && !/^https?:\/\/\S+\.\S+/.test(privacyUrl.trim())) out.push("Privacy policy link");
    if (daily < 1) out.push("Daily budget of at least $1");
    return out;
  }, [name, pageId, special, image, primaryText, headline, formMode, formId, privacyUrl, daily]);

  const create = async (launch: boolean) => {
    if (!image) return;
    setBusy(true);
    try {
      const r = await api.post<{ sample: boolean; status: string }>("/api/meta/campaigns", {
        name,
        adAccountId,
        pageId,
        instagramId: useInstagram && instagram ? instagram.id : "",
        locations: places,
        ageMin,
        ageMax,
        primaryText,
        headline,
        description,
        cta,
        image: { base64: image.dataUrl, filename: image.filename },
        form: formMode === "existing" ? { id: formId } : { create: { name: formName || `${name} form`, question, askTextConsent: askText, privacyUrl, websiteUrl } },
        dailyBudget: daily,
        specialCategory: special,
        launch,
      });
      toast(
        r.sample
          ? `Sample campaign “${name}” added. Connect Meta in Settings to create it for real.`
          : r.status === "ACTIVE"
            ? `“${name}” is on. Meta reviews new ads before they start, usually within a day.`
            : `“${name}” was created, paused. Turn it on from the campaign list when you're ready.`,
      );
      navigate("/ads");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't create the campaign", "bad");
    } finally {
      setBusy(false);
    }
  };

  const ready = missing.length === 0 && !busy;
  const smallImage = image && (image.width < 600 || image.height < 600);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <button className="btn ghost sm" style={{ marginBottom: 6, marginLeft: -8 }} onClick={() => navigate("/ads")}><ArrowLeft /> Meta Ads</button>
          <h2>New lead campaign</h2>
          <p>A Facebook{instagram && useInstagram ? " and Instagram" : ""} ad with a built-in lead form. Every lead lands in your CRM, ready for your automations.</p>
        </div>
      </div>

      {a && !a.connected && a.adAccounts.length > 0 && (
        <Banner tone="warn">
          Sample mode. <Link to="/settings#meta">Connect Meta</Link> to create real campaigns. You can still build one here to see how it works.
        </Banner>
      )}
      {a && !a.connected && a.adAccounts.length === 0 && (
        <Banner tone="info">
          <Link to="/settings#meta">Connect Meta in Settings</Link> to build campaigns. The builder needs your ad account and Facebook Page. You can still plan your ad here.
        </Banner>
      )}
      {assets.error && <Banner tone="bad">{assets.error}</Banner>}

      <div className="split-r builder">
        <div className="stack" style={{ gap: 16 }}>
          <Step n={1} title="Basics">
            <Field label="Campaign name (only you see this)"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Free roof inspection · Austin · Dec" /></Field>
            {!a ? (
              <Skeleton h={36} />
            ) : (
              <div className="grid-2">
                <Field label="Ad account" hint="Who pays for the ads.">
                  <select className="select" value={adAccountId} onChange={(e) => setAdAccountId(e.target.value)}>
                    {a.adAccounts.map((x) => <option key={x.id} value={x.id} disabled={!x.active}>{x.name}{x.active ? "" : " (inactive)"}</option>)}
                  </select>
                </Field>
                <Field label="Facebook Page" hint="Whose name the ad runs under.">
                  <select className="select" value={pageId} onChange={(e) => setPageId(e.target.value)}>
                    {!a.pages.length && <option value="">No Pages found</option>}
                    {a.pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </Field>
              </div>
            )}
            <div className="row small" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              {instagram ? (
                <label className="row" style={{ gap: 8 }}>
                  <Toggle on={useInstagram} onChange={setUseInstagram} label="Also run on Instagram" />
                  <span className="row" style={{ gap: 4 }}><ChannelIcon channel="IG" /> Also run on Instagram as @{instagram.username}</span>
                </label>
              ) : (
                <span className="faint">Facebook only. Link an Instagram account to this Page to run there too.</span>
              )}
            </div>
            <label className="row small" style={{ gap: 8 }}>
              <input type="checkbox" checked={special} onChange={(e) => setSpecial(e.target.checked)} /> This ad is about housing, jobs, credit or politics
            </label>
            {special && <Banner tone="warn">Meta has special rules for these ads (no age or ZIP targeting, extra review). Create this one in Meta Ads Manager instead.</Banner>}
            <div className="faint small">Running ads for a client? Ask them to add your business as a partner on their ad account and Page in Meta Business Settings. Their account then shows up in these lists.</div>
          </Step>

          <Step n={2} title="Who sees it" sub="Where they live and how old they are">
            <Field label="Locations" hint="Leave empty to show the ad across the whole United States." group>
              <div className="loc-search">
                <div className="input-icon">
                  <Search />
                  <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a city, state or ZIP code" aria-label="Search locations" />
                </div>
                {(hits.length > 0 || searching) && (
                  <div className="loc-hits" role="listbox">
                    {searching && !hits.length && <div className="faint small" style={{ padding: 10 }}>Searching…</div>}
                    {hits.map((h) => (
                      <button key={h.key} role="option" aria-selected="false" onClick={() => addPlace(h)}>
                        <MapPin /> <b>{h.name}</b> <span className="faint">{h.detail}</span> <span className="tag" style={{ marginLeft: "auto" }}>{TYPE_LABEL[h.type]}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {places.length > 0 && (
                <div className="loc-chips">
                  {places.map((p) => (
                    <span className="loc-chip" key={p.key}>
                      <MapPin />
                      <b>{p.name}</b>
                      <span className="faint">{TYPE_LABEL[p.type]}</span>
                      {p.type === "city" && (
                        <select
                          className="select"
                          value={p.radius}
                          aria-label={`Radius around ${p.name}`}
                          onChange={(e) => setPlaces((l) => l.map((x) => (x.key === p.key ? { ...x, radius: Number(e.target.value) } : x)))}
                        >
                          {[10, 15, 25, 40, 50].map((r) => <option key={r} value={r}>+{r} mi</option>)}
                        </select>
                      )}
                      <button className="icon-btn" aria-label={`Remove ${p.name}`} onClick={() => setPlaces((l) => l.filter((x) => x.key !== p.key))}><X /></button>
                    </span>
                  ))}
                </div>
              )}
            </Field>
            <div className="grid-2">
              <Field label="Youngest age">
                <select className="select" value={ageMin} onChange={(e) => setAgeMin(Math.min(Number(e.target.value), ageMax))}>
                  {Array.from({ length: 48 }, (_, i) => 18 + i).map((n) => <option key={n}>{n}</option>)}
                </select>
              </Field>
              <Field label="Oldest age">
                <select className="select" value={ageMax} onChange={(e) => setAgeMax(Math.max(Number(e.target.value), ageMin))}>
                  {Array.from({ length: 48 }, (_, i) => 18 + i).map((n) => <option key={n} value={n}>{n === 65 ? "65+" : n}</option>)}
                </select>
              </Field>
            </div>
          </Step>

          <Step n={3} title="The ad" sub="Image, words and button">
            <div
              className={`dropzone ${dragging ? "on" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                readImage(e.dataTransfer.files[0]);
              }}
            >
              {image ? (
                <>
                  <img src={image.dataUrl} alt="Ad image" />
                  <div className="small">
                    <div style={{ fontWeight: 600 }} className="ellipsis">{image.filename}</div>
                    <div className="faint">{image.width} × {image.height}</div>
                    <button className="btn sm" style={{ marginTop: 6 }} onClick={() => fileRef.current?.click()}>Change image</button>
                  </div>
                </>
              ) : (
                <button className="dropzone-empty" onClick={() => fileRef.current?.click()}>
                  <ImagePlus />
                  <b>Add the ad image</b>
                  <span className="faint small">Drop a JPG or PNG here, or click to choose. Square 1080 × 1080 works everywhere.</span>
                </button>
              )}
              <input ref={fileRef} type="file" accept="image/jpeg,image/png" hidden onChange={(e) => readImage(e.target.files?.[0])} />
            </div>
            {smallImage && <Banner tone="warn">This image is small ({image?.width} × {image?.height}). It may look blurry. Use at least 1080 × 1080.</Banner>}

            <div className="ai-copy">
              <div className="row" style={{ gap: 8, marginBottom: 8 }}>
                <Sparkles style={{ width: 16, height: 16, color: "var(--accent)" }} />
                <b className="small">Write it with AI</b>
                <span className="faint small">Paid Media Creative Strategist</span>
              </div>
              <div className="grid-2">
                <Field label="The offer"><input className="input" value={offer} onChange={(e) => setOffer(e.target.value)} placeholder="e.g. Free roof inspection" /></Field>
                <Field label="Who it's for"><input className="input" value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="e.g. Homeowners" /></Field>
              </div>
              <Field label="Anything else it should know (optional)"><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Family-owned, 24/7 emergency service, financing available" /></Field>
              <button className="btn" style={{ justifySelf: "start" }} onClick={writeCopy} disabled={writing || (!offer.trim() && !notes.trim())}>
                {writing ? <Spinner /> : <Sparkles />} {variants ? "Write 3 new versions" : "Write 3 versions"}
              </button>
              {variants && (
                <div className="variants">
                  {!aiUsed && <div className="faint small">Claude isn't connected, so these are simple templates. Add your Anthropic key in Settings for written copy.</div>}
                  {variants.map((v, i) => (
                    <button key={i} className={`variant ${primaryText === v.primaryText ? "on" : ""}`} onClick={() => pickVariant(v)}>
                      <span className="variant-angle">{v.angle}</span>
                      <span className="variant-text">{v.primaryText}</span>
                      <span className="variant-head">{v.headline}{v.description ? ` · ${v.description}` : ""}</span>
                      {primaryText === v.primaryText && <Check className="variant-check" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <Field label="Main text" hint={`${primaryText.length} characters · the first 125 show before “See more”`}>
              <textarea className="textarea" rows={4} value={primaryText} onChange={(e) => setPrimaryText(e.target.value)} placeholder="What you're offering, who it's for, and what to do next." />
            </Field>
            <div className="grid-2">
              <Field label="Headline" hint={`${headline.length}/40 recommended`}><input className="input" value={headline} onChange={(e) => setHeadline(e.target.value)} placeholder="e.g. Free roof inspection" /></Field>
              <Field label="Description (optional)"><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Takes 30 seconds" /></Field>
            </div>
            <Field label="Button">
              <select className="select" value={cta} onChange={(e) => setCta(e.target.value as Cta)}>
                {Object.entries(CTAS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
          </Step>

          <Step n={4} title="Lead form" sub="What people fill in after tapping the button">
            <div className="btn-group">
              <button className={`btn sm ${formMode === "new" ? "on" : ""}`} onClick={() => setFormMode("new")}>Create a new form</button>
              <button className={`btn sm ${formMode === "existing" ? "on" : ""}`} onClick={() => setFormMode("existing")} disabled={!a?.connected}>Use an existing form</button>
            </div>
            {formMode === "existing" ? (
              forms.loading ? (
                <Skeleton h={36} />
              ) : forms.data?.length ? (
                <Field label="Form">
                  <select className="select" value={formId} onChange={(e) => setFormId(e.target.value)}>
                    {forms.data.map((f) => <option key={f.id} value={f.id}>{f.name} · {f.leads} leads{f.status && f.status !== "ACTIVE" ? ` (${f.status.toLowerCase()})` : ""}</option>)}
                  </select>
                </Field>
              ) : (
                <div className="faint small">{forms.error ?? "This Page has no lead forms yet. Create a new one instead."}</div>
              )
            ) : (
              <>
                <div className="form-fields small">
                  <span className="muted">Always asks for:</span> <span className="tag">Full name</span> <span className="tag">Email</span> <span className="tag">Phone</span>
                  <span className="faint">Meta fills these in from their profile, so it takes seconds.</span>
                </div>
                <Field label="Extra question (optional)"><input className="input" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. What do you need help with?" /></Field>
                <label className="consent-row">
                  <Toggle on={askText} onChange={setAskText} label="Ask permission to text" />
                  <span>
                    <b>Ask “Can we text you about your request?”</b>
                    <span className="faint small">Recommended. A “Yes” tags the lead <code>sms-ok</code>; a “No” tags it <code>no-texts</code>, and Bloom AI then only emails them.</span>
                  </span>
                </label>
                <div className="grid-2">
                  <Field label="Privacy policy link" hint="Required by Meta: the business's own policy page."><input className="input" value={privacyUrl} onChange={(e) => setPrivacyUrl(e.target.value)} placeholder="https://yourbusiness.com/privacy" inputMode="url" /></Field>
                  <Field label="Website (optional)" hint="Button on the thank-you screen."><input className="input" value={websiteUrl} onChange={(e) => setWebsiteUrl(e.target.value)} placeholder="https://yourbusiness.com" inputMode="url" /></Field>
                </div>
                <Field label="Form name (only you see this)"><input className="input" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder={`${name || "Campaign"} form`} /></Field>
              </>
            )}
            <div className="faint small">Leads from the Page connected in Settings sync into Bloom AI. For a client's Page, connect the form in their GoHighLevel sub-account (Settings → Integrations → Facebook).</div>
          </Step>

          <Step n={5} title="Budget">
            <div className="grid-2">
              <Field label="Daily budget" hint="Meta spends about this much a day, sometimes a bit more on good days.">
                <div className="input-icon"><span className="input-prefix">{cur === "USD" ? "$" : cur}</span><input className="input mono" style={{ paddingLeft: cur === "USD" ? 24 : 48 }} inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} aria-label="Daily budget" /></div>
              </Field>
              <div className="budget-math">
                <div className="num" style={{ fontSize: 22 }}>{m(daily * 30.4)}</div>
                <div className="faint small">about a month at {m(daily)} a day</div>
              </div>
            </div>
            <div className="chips">
              {[10, 20, 30, 50].map((v) => <button key={v} className={`chip ${daily === v ? "on" : ""}`} onClick={() => setBudget(String(v))}>{m(v)}/day</button>)}
            </div>
            <div className="faint small">Starting out? $20 to $30 a day gives Meta enough data to find people who fill in the form. Judge it after 7 days, not 1.</div>
          </Step>
        </div>

        <div className="stack builder-side">
          <AdPreview page={page?.name ?? ""} text={primaryText} headline={headline} description={description} cta={cta} image={image?.dataUrl ?? ""} />
          <Card title="Ready to create?">
            {missing.length ? (
              <ul className="checklist">
                {missing.map((x) => <li key={x}><CircleAlert /> {x}</li>)}
              </ul>
            ) : (
              <div className="status-line good"><Check /> Everything's in place.</div>
            )}
            <div className="faint small" style={{ margin: "10px 0" }}>
              {places.length ? `${places.length} location${places.length > 1 ? "s" : ""}` : "Whole US"} · ages {ageMin}–{ageMax === 65 ? "65+" : ageMax} · {instagram && useInstagram ? "Facebook + Instagram" : "Facebook"} · {m(daily)}/day
            </div>
            <div className="stack" style={{ gap: 8 }}>
              <button className="btn" disabled={!ready} onClick={() => void create(false)}><Save /> {busy ? "Creating…" : "Create paused"}</button>
              <button className="btn primary" disabled={!ready || !a?.connected} onClick={() => setConfirm("launch")} title={!a?.connected ? "Connect Meta to launch real ads" : undefined}><Rocket /> Create and launch</button>
            </div>
            <div className="faint small" style={{ marginTop: 10 }}>Paused campaigns cost nothing. Meta reviews every new ad before it runs, usually within 24 hours.</div>
          </Card>
        </div>
      </div>

      {confirm && (
        <ConfirmModal title={`Launch “${name}”?`} confirmLabel="Launch campaign" tone="primary" onClose={() => setConfirm(null)} onConfirm={() => create(true)}>
          This spends up to about {m(daily)} a day ({m(daily * 30.4)} a month) from {account?.name ?? "the selected ad account"} once Meta approves the ad. You can pause it any time from Meta Ads.
        </ConfirmModal>
      )}
    </div>
  );
}
