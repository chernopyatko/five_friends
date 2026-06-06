import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

import { fileFromPath as openAIFileFromPath } from "openai/uploads";
import { MODEL_ROUTES } from "../llm/modelRouting.js";

export type VoiceTranscriptionErrorReason =
  | "TELEGRAM_FILE_PATH_MISSING"
  | "TELEGRAM_DOWNLOAD_FAILED"
  | "EMPTY_TRANSCRIPT";

export class VoiceTranscriptionError extends Error {
  readonly reason: VoiceTranscriptionErrorReason;

  constructor(reason: VoiceTranscriptionErrorReason, message: string) {
    super(message);
    this.name = "VoiceTranscriptionError";
    this.reason = reason;
  }
}

interface AudioTranscriptionClient {
  audio: {
    transcriptions: {
      create(input: { file: unknown; model: string }): Promise<{ text: string }>;
    };
  };
}

type FetchImpl = (url: string) => Promise<Response>;
type FileFromPath = (path: string, filename: string) => Promise<unknown>;

export interface OpenAIVoiceTranscriberOptions {
  botToken: string;
  client: AudioTranscriptionClient;
  model?: string;
  tempRoot?: string;
  fetchImpl?: FetchImpl;
  fileFromPath?: FileFromPath;
}

export interface TranscribeTelegramVoiceInput {
  fileId: string;
  fileUniqueId?: string;
  filePath?: string;
}

export class OpenAIVoiceTranscriber {
  private readonly botToken: string;
  private readonly client: AudioTranscriptionClient;
  private readonly model: string;
  private readonly tempRoot: string;
  private readonly fetchImpl: FetchImpl;
  private readonly fileFromPath: FileFromPath;

  constructor(options: OpenAIVoiceTranscriberOptions) {
    this.botToken = options.botToken;
    this.client = options.client;
    this.model = options.model ?? MODEL_ROUTES.voiceTranscription;
    this.tempRoot = options.tempRoot ?? tmpdir();
    this.fetchImpl = options.fetchImpl ?? ((url) => fetch(url));
    this.fileFromPath = options.fileFromPath ?? ((path, filename) => openAIFileFromPath(path, filename));
  }

  async transcribe(input: TranscribeTelegramVoiceInput): Promise<string> {
    if (!input.filePath) {
      throw new VoiceTranscriptionError(
        "TELEGRAM_FILE_PATH_MISSING",
        "Telegram did not return a downloadable voice file path."
      );
    }

    const tempDir = await mkdtemp(join(this.tempRoot, "five-friends-voice-"));
    const audioFilename = `${sanitizeFileStem(input.fileUniqueId ?? input.fileId)}${audioExtension(input.filePath)}`;
    const audioPath = join(tempDir, audioFilename);

    try {
      await this.downloadTelegramFile(input.filePath, audioPath);
      const file = await this.fileFromPath(audioPath, basename(audioPath));
      const response = await this.client.audio.transcriptions.create({
        file,
        model: this.model
      });
      const transcript = response.text.trim();
      if (transcript.length === 0) {
        throw new VoiceTranscriptionError("EMPTY_TRANSCRIPT", "Voice transcription returned an empty transcript.");
      }
      return transcript;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async downloadTelegramFile(filePath: string, destinationPath: string): Promise<void> {
    const response = await this.fetchImpl(buildTelegramFileUrl(this.botToken, filePath));
    if (!response.ok) {
      throw new VoiceTranscriptionError(
        "TELEGRAM_DOWNLOAD_FAILED",
        `Telegram voice download failed with status ${response.status}.`
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(destinationPath, bytes);
  }
}

export function buildTelegramFileUrl(botToken: string, filePath: string): string {
  const encodedToken = encodeURIComponent(botToken);
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  return `https://api.telegram.org/file/bot${encodedToken}/${encodedPath}`;
}

function sanitizeFileStem(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return sanitized.length > 0 ? sanitized : "voice";
}

function audioExtension(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".oga") {
    return ".ogg";
  }
  if ([".flac", ".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".ogg", ".wav", ".webm"].includes(extension)) {
    return extension;
  }
  return ".ogg";
}
