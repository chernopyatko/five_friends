import { extname } from "node:path";

import { MODEL_ROUTES } from "../llm/modelRouting.js";
import { buildTelegramFileUrl } from "./voiceTranscription.js";

export type ImageRecognitionErrorReason =
  | "TELEGRAM_FILE_PATH_MISSING"
  | "TELEGRAM_DOWNLOAD_FAILED"
  | "EMPTY_RECOGNITION";

export class ImageRecognitionError extends Error {
  readonly reason: ImageRecognitionErrorReason;

  constructor(reason: ImageRecognitionErrorReason, message: string) {
    super(message);
    this.name = "ImageRecognitionError";
    this.reason = reason;
  }
}

interface VisionChatCompletionMessage {
  content?: string | null;
}

interface VisionChatCompletionChoice {
  message?: VisionChatCompletionMessage;
}

interface VisionChatCompletionResponse {
  choices?: VisionChatCompletionChoice[];
}

interface VisionClient {
  chat: {
    completions: {
      create: unknown;
    };
  };
}

type FetchImpl = (url: string) => Promise<Response>;

export interface OpenAIImageRecognizerOptions {
  botToken: string;
  client: VisionClient;
  model?: string;
  fetchImpl?: FetchImpl;
}

export interface RecognizeTelegramImageInput {
  fileId: string;
  fileUniqueId?: string;
  filePath?: string;
}

export class OpenAIImageRecognizer {
  private readonly botToken: string;
  private readonly client: VisionClient;
  private readonly model: string;
  private readonly fetchImpl: FetchImpl;

  constructor(options: OpenAIImageRecognizerOptions) {
    this.botToken = options.botToken;
    this.client = options.client;
    this.model = options.model ?? MODEL_ROUTES.imageRecognition;
    this.fetchImpl = options.fetchImpl ?? ((url) => fetch(url));
  }

  async recognize(input: RecognizeTelegramImageInput): Promise<string> {
    if (!input.filePath) {
      throw new ImageRecognitionError(
        "TELEGRAM_FILE_PATH_MISSING",
        "Telegram did not return a downloadable image file path."
      );
    }

    const response = await this.fetchImpl(buildTelegramFileUrl(this.botToken, input.filePath));
    if (!response.ok) {
      throw new ImageRecognitionError(
        "TELEGRAM_DOWNLOAD_FAILED",
        `Telegram image download failed with status ${response.status}.`
      );
    }

    const mimeType = normalizeImageMimeType(response.headers.get("content-type"), input.filePath);
    const bytes = Buffer.from(await response.arrayBuffer());
    const dataUrl = `data:${mimeType};base64,${bytes.toString("base64")}`;
    const createCompletion = this.client.chat.completions.create as (
      this: unknown,
      input: Record<string, unknown>
    ) => Promise<VisionChatCompletionResponse>;
    const completion = await createCompletion.call(this.client.chat.completions, {
      model: this.model,
      messages: [{
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Извлеки текст и важный контекст из скриншота переписки. " +
              "Пиши по-русски. Не выдумывай имена, даты и смысл, которых нет на изображении. " +
              "Верни только распознанный текст/контекст, без объяснений."
          },
          {
            type: "image_url",
            image_url: {
              url: dataUrl,
              detail: "high"
            }
          }
        ]
      }]
    });
    const recognizedText = completion.choices?.[0]?.message?.content?.trim() ?? "";
    if (recognizedText.length === 0) {
      throw new ImageRecognitionError("EMPTY_RECOGNITION", "Image recognition returned an empty result.");
    }
    return recognizedText;
  }
}

function normalizeImageMimeType(contentType: string | null, filePath: string): string {
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
  if (normalized && normalized.startsWith("image/")) {
    return normalized;
  }
  const extension = extname(filePath).toLowerCase();
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  return "image/jpeg";
}
