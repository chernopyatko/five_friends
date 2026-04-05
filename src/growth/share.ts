export interface ShareLinkResult {
  url: string;
  isPlaceholder: boolean;
}

const VALID_TG_USERNAME = /^[a-zA-Z][a-zA-Z0-9_]{3,30}[a-zA-Z0-9]$/;

export function buildShareLink(botUsername: string | undefined, inviterCode: string): ShareLinkResult {
  const normalizedUsername = (botUsername ?? "").trim().replace(/^@/, "");
  const encodedCode = encodeURIComponent(inviterCode);
  if (!normalizedUsername || !VALID_TG_USERNAME.test(normalizedUsername)) {
    return {
      url: `https://t.me/<BOT_USERNAME>?start=ref_${encodedCode}`,
      isPlaceholder: true
    };
  }

  return {
    url: `https://t.me/${normalizedUsername}?start=ref_${encodedCode}`,
    isPlaceholder: false
  };
}

export function formatShareLinkMessage(link: string): string {
  return `Вот твоя ссылка для приглашения:\n${link}`;
}
