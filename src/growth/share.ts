export interface ShareLinkResult {
  url: string;
  isPlaceholder: boolean;
}

export function buildShareLink(botUsername: string | undefined, inviterCode: string): ShareLinkResult {
  const normalizedUsername = (botUsername ?? "").trim().replace(/^@/, "");
  if (!normalizedUsername) {
    return {
      url: `https://t.me/<BOT_USERNAME>?start=ref_${inviterCode}`,
      isPlaceholder: true
    };
  }

  return {
    url: `https://t.me/${normalizedUsername}?start=ref_${inviterCode}`,
    isPlaceholder: false
  };
}

export function formatShareLinkMessage(link: string): string {
  return `Вот твоя ссылка для приглашения:\n${link}`;
}
