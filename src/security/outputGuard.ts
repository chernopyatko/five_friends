const ROLE_TOKEN_PATTERN = /\b(system|developer|tool|assistant|user)\s*:|<\s*(system|developer|tool|assistant|user)\s*>/gi;
const URL_PATTERN = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
const MARKDOWN_ARTIFACT_PATTERN =
  /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|(^|[^*])\*[^*\n]+\*(?!\*)|(^|[^_])_[^_\n]+_(?!_))/gm;

export interface OutputGuardResult {
  text: string;
  repaired: boolean;
  usedFallback: boolean;
  issues: string[];
}

export function guardOutputText(text: string, fallback: string): OutputGuardResult {
  const firstPass = inspectOutput(text);
  if (firstPass.issues.length === 0) {
    return {
      text,
      repaired: false,
      usedFallback: false,
      issues: []
    };
  }

  const repairedText = repairOutput(text);
  const secondPass = inspectOutput(repairedText);
  if (secondPass.issues.length === 0 && repairedText.trim().length > 0) {
    return {
      text: repairedText,
      repaired: true,
      usedFallback: false,
      issues: firstPass.issues
    };
  }

  return {
    text: fallback,
    repaired: false,
    usedFallback: true,
    issues: firstPass.issues
  };
}

export function inspectOutput(text: string): { issues: string[] } {
  const issues: string[] = [];
  if (ROLE_TOKEN_PATTERN.test(text)) {
    issues.push("ROLE_TOKEN");
  }
  if (URL_PATTERN.test(text)) {
    issues.push("URL");
  }
  if (MARKDOWN_ARTIFACT_PATTERN.test(text)) {
    issues.push("MARKDOWN_FORMAT");
  }
  resetRegexState();
  return { issues };
}

function repairOutput(text: string): string {
  let repaired = text.replace(ROLE_TOKEN_PATTERN, "");
  repaired = repaired.replace(URL_PATTERN, "");
  repaired = stripMarkdownArtifacts(repaired);
  resetRegexState();
  return repaired.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function resetRegexState(): void {
  ROLE_TOKEN_PATTERN.lastIndex = 0;
  URL_PATTERN.lastIndex = 0;
  MARKDOWN_ARTIFACT_PATTERN.lastIndex = 0;
}

function stripMarkdownArtifacts(text: string): string {
  let cleaned = text;
  cleaned = cleaned.replace(/```(?:\w+)?\n?/g, "");
  cleaned = cleaned.replace(/`([^`\n]+)`/g, "$1");
  cleaned = cleaned.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  cleaned = cleaned.replace(/__([^_\n]+)__/g, "$1");
  cleaned = cleaned.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/gm, "$1$2");
  cleaned = cleaned.replace(/(^|[^_])_([^_\n]+)_(?!_)/gm, "$1$2");
  return cleaned;
}
