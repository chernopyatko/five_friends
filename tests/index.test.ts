import { describe, expect, it } from "vitest";

import { parseSupportedCommand } from "../src/index.js";

describe("index command parsing", () => {
  it("parses supported commands", () => {
    expect(parseSupportedCommand("/start")).toBe("/start");
    expect(parseSupportedCommand("/friends@mybot")).toBe("/friends");
    expect(parseSupportedCommand("/reset now")).toBe("/reset");
    expect(parseSupportedCommand("/settings")).toBe("/settings");
    expect(parseSupportedCommand("/demo")).toBe("/demo");
  });

  it("returns null for unsupported commands or plain text", () => {
    expect(parseSupportedCommand("hello")).toBeNull();
    expect(parseSupportedCommand("/unknown")).toBeNull();
  });
});
