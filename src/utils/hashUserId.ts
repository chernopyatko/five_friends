import { createHash } from "node:crypto";

export function hashUserId(userId: string | number): string {
  const salt = process.env.TELEMETRY_SALT ?? "dev-salt";
  return createHash("sha256").update(`${salt}:${userId}`).digest("hex").slice(0, 16);
}
