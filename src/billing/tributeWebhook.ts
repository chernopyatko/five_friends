import { createHmac, timingSafeEqual } from "node:crypto";

export interface TributeWebhookEvent {
  eventType: string;
  telegramId: string;
  productId: string;
  purchaseId: string;
}

const SIGNATURE_PREFIX = "sha256=";

export function verifyTributeSignature(input: {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  apiSecret: string;
}): boolean {
  const normalizedSignature = normalizeSignature(input.signatureHeader);
  if (!normalizedSignature || !input.apiSecret) {
    return false;
  }

  const expectedHex = createHmac("sha256", input.apiSecret).update(input.rawBody).digest("hex");
  const expectedBuffer = Buffer.from(expectedHex, "hex");
  const providedBuffer = Buffer.from(normalizedSignature, "hex");

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

export function loadProductMap(rawValue: string | undefined): Record<string, number> {
  if (!rawValue) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return {};
  }

  if (!isRecord(parsed)) {
    return {};
  }

  const productMap: Record<string, number> = {};
  for (const [productId, value] of Object.entries(parsed)) {
    const normalizedProductId = productId.trim();
    const normalizedAmount = normalizeAmount(value);
    if (!normalizedProductId || normalizedAmount === null) {
      continue;
    }
    productMap[normalizedProductId] = normalizedAmount;
  }

  return productMap;
}

export function parseTributeWebhookEvent(payload: unknown): TributeWebhookEvent | null {
  if (!isRecord(payload)) {
    return null;
  }

  const eventType = readNonEmptyString(payload.name);
  if (!eventType) {
    return null;
  }

  if (!isRecord(payload.payload)) {
    return null;
  }
  const payloadData = payload.payload;

  const telegramId = readIdentifier(payloadData.telegram_user_id);
  const productId = readIdentifier(payloadData.product_id);
  const purchaseId = readIdentifier(payloadData.purchase_id);

  if (!telegramId || !productId || !purchaseId) {
    return null;
  }

  return {
    eventType,
    telegramId,
    productId,
    purchaseId
  };
}

function normalizeSignature(signatureHeader: string | undefined): string | null {
  if (!signatureHeader) {
    return null;
  }

  const trimmed = signatureHeader.trim();
  const raw = trimmed.startsWith(SIGNATURE_PREFIX) ? trimmed.slice(SIGNATURE_PREFIX.length) : trimmed;
  if (!raw || raw.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(raw)) {
    return null;
  }

  return raw.toLowerCase();
}

function normalizeAmount(value: unknown): number | null {
  const numericValue =
    typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;

  if (!Number.isFinite(numericValue) || numericValue <= 0 || !Number.isInteger(numericValue)) {
    return null;
  }

  return numericValue;
}

function readIdentifier(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    return String(value);
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
