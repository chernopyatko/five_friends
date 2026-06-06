import { describe, expect, it } from "vitest";

import { ImageRecognitionError, OpenAIImageRecognizer } from "../../src/telegram/imageRecognition.js";

describe("image recognition", () => {
  it("downloads Telegram image and recognizes screenshot text", async () => {
    const requests: Record<string, unknown>[] = [];
    const recognizer = new OpenAIImageRecognizer({
      botToken: "123:abc",
      model: "gpt-4o-mini",
      async fetchImpl(url) {
        expect(url).toBe("https://api.telegram.org/file/bot123%3Aabc/photos/screen%2042.png");
        return new Response("fake-image-bytes", {
          status: 200,
          headers: { "content-type": "image/png" }
        });
      },
      client: {
        chat: {
          completions: {
            async create(input: Record<string, unknown>) {
              requests.push(input);
              return {
                choices: [{ message: { content: "  Она написала: «я устала от молчания»  " } }]
              };
            }
          }
        }
      }
    });

    const text = await recognizer.recognize({
      fileId: "photo-file-id",
      fileUniqueId: "photo-unique-id",
      filePath: "photos/screen 42.png"
    });

    expect(text).toBe("Она написала: «я устала от молчания»");
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain("data:image/png;base64,ZmFrZS1pbWFnZS1ieXRlcw==");
  });

  it("fails with a typed error when Telegram does not return a file path", async () => {
    const recognizer = new OpenAIImageRecognizer({
      botToken: "123:abc",
      async fetchImpl() {
        throw new Error("should not download without file_path");
      },
      client: {
        chat: {
          completions: {
            async create() {
              throw new Error("should not recognize without file_path");
            }
          }
        }
      }
    });

    await expect(recognizer.recognize({
      fileId: "photo-file-id"
    })).rejects.toMatchObject({
      name: "ImageRecognitionError",
      reason: "TELEGRAM_FILE_PATH_MISSING"
    } satisfies Partial<ImageRecognitionError>);
  });
});
