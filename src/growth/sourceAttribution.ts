export type AttributionSource = "referral" | "google_ads" | "telegram_ads" | "utm";

export interface StartPayloadAttribution {
  source: AttributionSource | null;
  campaign: string | null;
  rawPayload: string | null;
}

const MAX_CAMPAIGN_LENGTH = 64;

export function parseStartPayload(payload?: string | null): StartPayloadAttribution {
  if (!payload) {
    return {
      source: null,
      campaign: null,
      rawPayload: null
    };
  }

  const rawPayload = payload.trim();
  if (rawPayload.length === 0) {
    return {
      source: null,
      campaign: null,
      rawPayload: null
    };
  }

  if (rawPayload.startsWith("ref_")) {
    return {
      source: "referral",
      campaign: null,
      rawPayload
    };
  }

  if (rawPayload.startsWith("gads_")) {
    return {
      source: "google_ads",
      campaign: sanitizeCampaign(rawPayload.slice(5)),
      rawPayload
    };
  }

  if (rawPayload.startsWith("tgads_")) {
    return {
      source: "telegram_ads",
      campaign: sanitizeCampaign(rawPayload.slice(6)),
      rawPayload
    };
  }

  if (rawPayload.startsWith("utm_")) {
    return {
      source: "utm",
      campaign: sanitizeCampaign(rawPayload.slice(4)),
      rawPayload
    };
  }

  return {
    source: null,
    campaign: null,
    rawPayload
  };
}

export function sanitizeCampaign(raw: string): string | null {
  const cleaned = raw.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, MAX_CAMPAIGN_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
}
