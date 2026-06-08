import { loadProductMap } from "./tributeWebhook.js";

export interface TributeLinks {
  small: string;
  medium: string;
  large: string;
}

export interface BillingConfig {
  tributeApiSecret?: string;
  tributeLinks: TributeLinks;
  productMap: Record<string, number>;
  isEnabled?: boolean;
  isConfigured: boolean;
}

export function loadBillingConfig(env: NodeJS.ProcessEnv = process.env): BillingConfig {
  const isEnabled = parseBillingEnabled(env.BILLING_ENABLED);
  const tributeApiSecret = normalizeEnvValue(env.TRIBUTE_API_SECRET);
  const tributeLinks: TributeLinks = {
    small: validateUrl(env.TRIBUTE_LINK_SMALL),
    medium: validateUrl(env.TRIBUTE_LINK_MEDIUM),
    large: validateUrl(env.TRIBUTE_LINK_LARGE)
  };
  const productMap = loadProductMap(normalizeEnvValue(env.TRIBUTE_PRODUCT_MAP));

  const isConfigured =
    isEnabled &&
    Boolean(tributeApiSecret) &&
    Boolean(tributeLinks.small && tributeLinks.medium && tributeLinks.large) &&
    Object.keys(productMap).length > 0;

  return {
    tributeApiSecret,
    tributeLinks,
    productMap,
    isEnabled,
    isConfigured
  };
}

function parseBillingEnabled(value: string | undefined): boolean {
  const normalized = normalizeEnvValue(value)?.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function validateUrl(value: string | undefined): string {
  const candidate = normalizeEnvValue(value);
  if (!candidate) {
    return "";
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
}
