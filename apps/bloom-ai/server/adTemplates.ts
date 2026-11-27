// Pure helpers shared by the server and the static preview build: button labels,
// sample locations, and plain ad-copy templates used when Claude isn't connected.

export const CTAS = {
  GET_QUOTE: "Get quote",
  LEARN_MORE: "Learn more",
  SIGN_UP: "Sign up",
  APPLY_NOW: "Apply now",
  SUBSCRIBE: "Subscribe",
} as const;
export type Cta = keyof typeof CTAS;

export interface AdLocation {
  key: string;
  name: string;
  type: "city" | "zip" | "region";
  detail: string;
  /** Miles around a city (10–50). Ignored for ZIP codes and states. */
  radius?: number;
}

export const SAMPLE_PLACES: AdLocation[] = [
  { key: "s-austin", name: "Austin", type: "city", detail: "Texas, United States" },
  { key: "s-dallas", name: "Dallas", type: "city", detail: "Texas, United States" },
  { key: "s-houston", name: "Houston", type: "city", detail: "Texas, United States" },
  { key: "s-phoenix", name: "Phoenix", type: "city", detail: "Arizona, United States" },
  { key: "s-denver", name: "Denver", type: "city", detail: "Colorado, United States" },
  { key: "s-tampa", name: "Tampa", type: "city", detail: "Florida, United States" },
  { key: "s-atlanta", name: "Atlanta", type: "city", detail: "Georgia, United States" },
  { key: "s-chicago", name: "Chicago", type: "city", detail: "Illinois, United States" },
  { key: "s-tx", name: "Texas", type: "region", detail: "United States" },
  { key: "s-fl", name: "Florida", type: "region", detail: "United States" },
  { key: "s-78701", name: "78701", type: "zip", detail: "Austin, Texas" },
  { key: "s-85004", name: "85004", type: "zip", detail: "Phoenix, Arizona" },
];

export interface CopyInput {
  business: string;
  offer: string;
  audience: string;
  place: string;
  notes: string;
  cta: Cta;
}
export interface CopyVariant {
  angle: string;
  primaryText: string;
  headline: string;
  description: string;
}

/** Plain variants from the inputs, used when Claude isn't connected. No claims that weren't given. */
export function templateCopy(i: CopyInput): CopyVariant[] {
  // A placeholder Page name ("Your business") reads wrong mid-sentence.
  const business = !i.business || /^your\b/i.test(i.business) ? "our team" : i.business;
  const offer = i.offer || "A free quote";
  const bare = offer.charAt(0).toLowerCase() + offer.slice(1);
  const lower = /^(a|an|the|your|our)\b/.test(bare) || /s$/.test(bare) ? bare : `${/^[aeiou]/.test(bare) ? "an" : "a"} ${bare}`;
  const who = i.audience || "Homeowners";
  const where = i.place ? ` in ${i.place}` : "";
  const button = CTAS[i.cta];
  return [
    { angle: "The offer, straight", primaryText: `${offer} from ${business}${where}. It takes 30 seconds to ask: tap "${button}" and we'll be in touch.`, headline: offer.slice(0, 40), description: business },
    { angle: "Speak to who it's for", primaryText: `${who}${where}: request ${lower} from ${business}. Fill in the short form and a real person gets back to you.`, headline: `Request ${lower}`.slice(0, 40), description: "Takes 30 seconds" },
    { angle: "Local and easy", primaryText: `Thinking about it but not sure where to start? ${business} works with ${who.toLowerCase()}${where}. Start with ${lower}, with no pressure to buy.`, headline: i.place ? `Local help in ${i.place}`.slice(0, 40) : "Local help, no pressure", description: offer },
  ];
}
