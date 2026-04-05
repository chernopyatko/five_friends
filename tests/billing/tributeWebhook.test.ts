import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { loadProductMap, parseTributeWebhookEvent, verifyTributeSignature } from "../../src/billing/tributeWebhook.js";

describe("tribute webhook helpers", () => {
  it("verifies both hex and sha256=hex signatures", () => {
    const apiSecret = "test-secret";
    const rawBody = Buffer.from("{\"name\":\"new_digital_product\"}");
    const hex = createHmac("sha256", apiSecret).update(rawBody).digest("hex");

    expect(verifyTributeSignature({ rawBody, apiSecret, signatureHeader: hex })).toBe(true);
    expect(verifyTributeSignature({ rawBody, apiSecret, signatureHeader: `sha256=${hex}` })).toBe(true);
    expect(verifyTributeSignature({ rawBody, apiSecret, signatureHeader: "bad" })).toBe(false);
  });

  it("parses strict tribute payload and normalizes numeric ids", () => {
    const parsed = parseTributeWebhookEvent({
      name: "new_digital_product",
      created_at: "2025-03-20T01:15:58.33246Z",
      sent_at: "2025-03-20T01:15:58.542279448Z",
      payload: {
        product_id: 456,
        product_name: "50 сообщений",
        amount: 500,
        currency: "rub",
        trb_user_id: "T-31326",
        telegram_user_id: 12321321,
        telegram_username: "durov",
        purchase_id: 78901,
        transaction_id: 234567
      }
    });

    expect(parsed).toEqual({
      eventType: "new_digital_product",
      telegramId: "12321321",
      productId: "456",
      purchaseId: "78901"
    });
  });

  it("rejects invalid webhook payload fields", () => {
    expect(
      parseTributeWebhookEvent({
        name: "new_digital_product",
        payload: {
          telegram_user_id: {},
          product_id: 456,
          purchase_id: 78901
        }
      })
    ).toBeNull();

    expect(
      parseTributeWebhookEvent({
        name: "new_digital_product",
        payload: {
          telegram_user_id: 12321321,
          product_id: "",
          purchase_id: 78901
        }
      })
    ).toBeNull();

    expect(
      parseTributeWebhookEvent({
        name: "new_digital_product",
        payload: {
          telegram_user_id: 12321321,
          product_id: 456,
          purchase_id: Number.NaN
        }
      })
    ).toBeNull();
  });

  it("parses refund event payload", () => {
    const parsed = parseTributeWebhookEvent({
      name: "digital_product_refunded",
      payload: {
        product_id: 456,
        telegram_user_id: 12321321,
        purchase_id: 78901
      }
    });

    expect(parsed).toEqual({
      eventType: "digital_product_refunded",
      telegramId: "12321321",
      productId: "456",
      purchaseId: "78901"
    });
  });

  it("loads product map safely", () => {
    expect(loadProductMap('{"p50":50,"p150":"150","bad":0}')).toEqual({ p50: 50, p150: 150 });
    expect(loadProductMap("{bad json")).toEqual({});
    expect(loadProductMap(undefined)).toEqual({});
  });
});
