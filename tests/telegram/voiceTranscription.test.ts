import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildTelegramFileUrl, OpenAIVoiceTranscriber, VoiceTranscriptionError } from "../../src/telegram/voiceTranscription.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function createTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "five-friends-voice-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("voice transcription", () => {
  it("builds a Telegram file download URL with escaped path segments", () => {
    expect(buildTelegramFileUrl("123:abc", "voice/file 42.oga")).toBe(
      "https://api.telegram.org/file/bot123%3Aabc/voice/file%2042.oga"
    );
  });

  it("downloads Telegram voice, transcribes it, and removes the temp file", async () => {
    const tempRoot = createTempRoot();
    const transcriptionCalls: Array<{ file: unknown; model: string }> = [];
    let observedAudioPath = "";
    let observedFilename = "";

    const transcriber = new OpenAIVoiceTranscriber({
      botToken: "123:abc",
      tempRoot,
      async fetchImpl(url) {
        expect(url).toBe("https://api.telegram.org/file/bot123%3Aabc/voice/file_42.oga");
        return new Response("fake-audio-bytes", { status: 200 });
      },
      async fileFromPath(path, filename) {
        observedAudioPath = path;
        observedFilename = filename;
        expect(await readFile(path, "utf8")).toBe("fake-audio-bytes");
        return { path, filename };
      },
      client: {
        audio: {
          transcriptions: {
            async create(input) {
              transcriptionCalls.push(input);
              return { text: "  привет из войса  " };
            }
          }
        }
      }
    });

    const transcript = await transcriber.transcribe({
      fileId: "voice-file-id",
      fileUniqueId: "voice-unique-id",
      filePath: "voice/file_42.oga"
    });

    expect(transcript).toBe("привет из войса");
    expect(observedFilename).toBe("voice-unique-id.ogg");
    expect(observedAudioPath.endsWith("voice-unique-id.ogg")).toBe(true);
    expect(transcriptionCalls).toEqual([{ file: { path: observedAudioPath, filename: observedFilename }, model: "gpt-4o-mini-transcribe" }]);
    expect(existsSync(dirname(observedAudioPath))).toBe(false);
  });

  it("fails with a typed error when Telegram does not return a file path", async () => {
    const transcriber = new OpenAIVoiceTranscriber({
      botToken: "123:abc",
      tempRoot: createTempRoot(),
      async fetchImpl() {
        throw new Error("should not download without file_path");
      },
      async fileFromPath() {
        throw new Error("should not create upload without file_path");
      },
      client: {
        audio: {
          transcriptions: {
            async create() {
              throw new Error("should not transcribe without file_path");
            }
          }
        }
      }
    });

    await expect(transcriber.transcribe({
      fileId: "voice-file-id"
    })).rejects.toMatchObject({
      name: "VoiceTranscriptionError",
      reason: "TELEGRAM_FILE_PATH_MISSING"
    } satisfies Partial<VoiceTranscriptionError>);
  });
});
