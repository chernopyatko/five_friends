const ALLOWED_KINDS = ["fact", "preference", "thread", "episode"] as const;
const ROLE_TOKEN_PATTERN = /\b(system|developer|tool|assistant|user)\s*:|<\s*(system|developer|tool|assistant|user)\s*>/gi;
const URL_PATTERN = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;

export type LongTermKind = (typeof ALLOWED_KINDS)[number];

export interface LongTermCandidate {
  kind: string;
  text: string;
  importance?: number;
  confidence?: number;
}

export interface LongTermMemory {
  kind: LongTermKind;
  text: string;
  importance: number;
  confidence: number;
}

export interface LongTermExtractInput {
  rollingSummary: string;
  recentMessages: Array<{ role: "user" | "assistant"; text: string }>;
}

export interface MiniApiClient {
  responses: {
    create(input: Record<string, unknown>): Promise<unknown>;
  };
}

export function buildLongTermExtractionRequest(input: LongTermExtractInput): Record<string, unknown> {
  const context = input.recentMessages
    .map((message) => `${message.role.toUpperCase()}: ${message.text}`)
    .join("\n");

  return {
    model: "gpt-5-mini",
    reasoning: { effort: "high" },
    instructions:
      "Выдели только устойчивые long-term заметки пользователя. " +
      "Формат JSON-объект: {items:[{kind,text,importance,confidence}]}. " +
      "kind только fact|preference|thread|episode.",
    text: {
      format: {
        type: "json_schema",
        name: "long_term_candidates",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["items"],
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["kind", "text", "importance", "confidence"],
                properties: {
                  kind: { type: "string", enum: [...ALLOWED_KINDS] },
                  text: { type: "string", minLength: 1, maxLength: 280 },
                  importance: { type: "number", minimum: 1, maximum: 5 },
                  confidence: { type: "number", minimum: 0, maximum: 1 }
                }
              },
              maxItems: 8
            }
          }
        }
      }
    },
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              `ROLLING_SUMMARY_START\n${input.rollingSummary}\nROLLING_SUMMARY_END\n\n` +
              `RECENT_MESSAGES_START\n${context}\nRECENT_MESSAGES_END`
          }
        ]
      }
    ]
  };
}

export async function extractLongTermCandidates(
  client: MiniApiClient,
  input: LongTermExtractInput
): Promise<LongTermMemory[]> {
  const response = await client.responses.create(buildLongTermExtractionRequest(input));
  const text = extractOutputText(response);
  const parsed = JSON.parse(text) as unknown;
  const candidates = normalizeParsedCandidates(parsed);
  return sanitizeLongTermCandidates(candidates);
}

export function sanitizeLongTermCandidates(candidates: LongTermCandidate[]): LongTermMemory[] {
  const result: LongTermMemory[] = [];

  for (const candidate of candidates) {
    if (!isAllowedKind(candidate.kind)) {
      continue;
    }

    const cleanedText = sanitizeText(candidate.text ?? "");
    if (!cleanedText) {
      continue;
    }

    const importance = clampInt(candidate.importance ?? 3, 1, 5);
    const confidence = clampFloat(candidate.confidence ?? 0.7, 0, 1);

    result.push({
      kind: candidate.kind,
      text: cleanedText,
      importance,
      confidence
    });
  }

  return result;
}

function isAllowedKind(value: string): value is LongTermKind {
  return ALLOWED_KINDS.includes(value as LongTermKind);
}

function sanitizeText(value: string): string {
  const withoutRoles = value.replace(ROLE_TOKEN_PATTERN, "");
  const withoutLinks = withoutRoles.replace(URL_PATTERN, "");
  ROLE_TOKEN_PATTERN.lastIndex = 0;
  URL_PATTERN.lastIndex = 0;
  return withoutLinks.trim();
}

function clampInt(value: number, min: number, max: number): number {
  const normalized = Number.isFinite(value) ? Math.round(value) : min;
  return Math.min(max, Math.max(min, normalized));
}

function clampFloat(value: number, min: number, max: number): number {
  const normalized = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, normalized));
}

function extractOutputText(response: unknown): string {
  if (!isRecord(response)) {
    throw new Error("Mini response must be object.");
  }
  const outputText = response.output_text;
  if (typeof outputText !== "string" || !outputText.trim()) {
    throw new Error("Mini response missing output_text.");
  }
  return outputText.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeParsedCandidates(parsed: unknown): LongTermCandidate[] {
  // Backward compatible with legacy array format used in tests/older runs.
  if (Array.isArray(parsed)) {
    return parsed as LongTermCandidate[];
  }
  if (isRecord(parsed) && Array.isArray(parsed.items)) {
    return parsed.items as LongTermCandidate[];
  }
  throw new Error("Long-term extraction response must be array or {items:[]}");
}
