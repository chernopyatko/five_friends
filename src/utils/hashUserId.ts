import { createHash } from "node:crypto";

let saltWarningLogged = false;

export function hashUserId(userId: string | number): string {
  const salt = process.env.TELEMETRY_SALT;
  if (!salt && !saltWarningLogged) {
    saltWarningLogged = true;
    // eslint-disable-next-line no-console
    console.warn("[hashUserId] TELEMETRY_SALT is not set — using dev fallback. Set it in production to ensure privacy.");
  }
  return createHash("sha256").update(`${salt ?? "dev-salt"}:${userId}`).digest("hex").slice(0, 16);
}
