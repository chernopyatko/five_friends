import { runGenerator, type GeneratorApiClient } from "../llm/generator.js";
import { buildPromptInstructions } from "../llm/promptBuilder.js";
import { runRouter, type RouterApiClient } from "../llm/router.js";
import type { RouterDecision } from "../llm/routerSchema.js";
import { runMemoryUpdate } from "../memory/memoryUpdater.js";
import { splitMessage, validatePanelFormat } from "../modes/panel.js";
import { formatSingleResponse } from "../modes/single.js";
import { formatSummaryResponse } from "../modes/summary.js";
import { resolveModelPolicy } from "../policy/modelPolicy.js";
import { guardOutputText } from "../security/outputGuard.js";
import { classifySafety, getCrisisResponder, getSafetyCheck } from "../security/safety.js";
import type { UserSessionState } from "../state/session.js";
import {
  type MemoryKind,
  type NewMemoryInput,
  SqliteStore
} from "../state/store.js";
import type { LLMResponder } from "../telegram/bot.js";
import type { LLMTask, OutgoingMessage } from "../telegram/uxHandlers.js";
import { estimateTotalTokens } from "../utils/tokenCount.js";
import { formatPanelFallback, formatSingleFallback, formatSummaryFallback } from "./modeFallbacks.js";

type OpenAIClient = RouterApiClient & GeneratorApiClient;

interface MemoryState {
  rollingSummary: string;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  longTerm: Array<{
    kind: MemoryKind;
    text: string;
    importance: number;
    confidence: number;
  }>;
}

interface OpenAILLMResponderOptions {
  store?: SqliteStore;
  dbPath?: string;
}

const ROUTER_INSTRUCTIONS = [
  "Ты router для Telegram-бота друзей.",
  "Возвращай ТОЛЬКО JSON по схеме.",
  "Никакого пользовательского текста и объяснений."
].join(" ");

export class OpenAILLMResponder implements LLMResponder {
  private readonly client: OpenAIClient;
  private readonly store: SqliteStore;

  constructor(client: OpenAIClient, options: OpenAILLMResponderOptions = {}) {
    this.client = client;
    this.store = options.store ?? new SqliteStore(options.dbPath ?? process.env.SQLITE_PATH ?? "data/bot.sqlite");
  }

  async generate(input: {
    userId: string;
    task: LLMTask;
    state: UserSessionState;
  }): Promise<OutgoingMessage[]> {
    const { task, userId, state } = input;

    this.store.ensureSession({
      id: state.sessionId,
      userId,
      startedAt: state.sessionStartTs,
      lastActivityAt: state.lastActivityTs
    });

    const memoryState = this.loadMemoryState(userId, state.sessionId);
    const safety = classifySafety(task.userText);

    if (safety === "hard") {
      const crisis = getCrisisResponder();
      return [{ text: crisis.text }];
    }
    if (safety === "soft") {
      const soft = getSafetyCheck();
      return [{ text: soft.text }];
    }

    const isForcedMode = task.mode === "PANEL" || task.mode === "SUMMARY";
    const routerDecision = isForcedMode ? null : await this.tryRouterDecision(task.userText);
    const policy = resolveModelPolicy({
      userText: task.userText,
      state: {
        pendingMode: state.pendingMode
      },
      forcedMode: isForcedMode ? (task.mode as "PANEL" | "SUMMARY") : null,
      routerDecision,
      tokenEstimate: estimateTotalTokens({
        userMessage: task.userText,
        memoryBlock: buildMemoryBlock(memoryState),
        history: memoryState.history.map((turn) => turn.text)
      })
    });

    if (policy.mode === "CRISIS") {
      const crisis = getCrisisResponder();
      return [{ text: crisis.text }];
    }

    const effectiveMode = policy.mode;
    const persona = effectiveMode === "SINGLE" ? task.persona : undefined;
    const toolScenario = effectiveMode === "SINGLE" ? task.scenario ?? null : null;
    if (effectiveMode === "SINGLE" && !persona) {
      return [{ text: formatSingleFallback("yan") }];
    }

    const instructions = buildPromptInstructions({
      mode: effectiveMode,
      persona: effectiveMode === "SINGLE" ? persona : null,
      toolScenario,
      memoryBlock: buildMemoryBlock(memoryState),
      userMessage: task.userText
    });

    const generation = await runGenerator(this.client, {
      mode: effectiveMode,
      instructions,
      userText: task.userText,
      escalateSingle: effectiveMode === "SINGLE" ? policy.model === "gpt-5.2" : false
    });

    const fallbackText = buildFallbackTextForMode(effectiveMode, persona);
    const guard = guardOutputText(generation.text, fallbackText);
    const formatted = formatModeOutput({
      mode: effectiveMode,
      persona,
      text: guard.text,
      fallback: fallbackText
    });

    this.persistTurnAndRefreshMemory({
      userId,
      sessionId: state.sessionId,
      userText: task.userText,
      assistantText: formatted,
      existingSummary: memoryState.rollingSummary
    }).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("[memory-update] background refresh failed:", err instanceof Error ? err.message : err);
    });

    return splitMessage(formatted).map((text) => ({ text }));
  }

  clearLongTerm(userId: string): void {
    this.store.deleteLongTermMemories(userId);
  }

  resetSession(input: { userId: string; previousSessionId: string; newSessionId: string }): void {
    this.store.clearSessionWorkingMemory(input.previousSessionId);
    this.store.ensureSession({
      id: input.newSessionId,
      userId: input.userId,
      startedAt: Date.now()
    });
  }

  private loadMemoryState(userId: string, sessionId: string): MemoryState {
    const session = this.store.getSessionById(sessionId);
    const rollingSummary = session?.rollingSummary ?? "";
    const history = this.store.listSessionMessages(sessionId, 12).map((message) => ({
      role: message.role,
      text: message.text
    }));
    const longTerm = this.store.listLongTermMemories(userId, 8).map((item) => ({
      kind: item.kind,
      text: item.text,
      importance: item.importance,
      confidence: item.confidence
    }));

    return {
      rollingSummary,
      history,
      longTerm
    };
  }

  private async persistTurnAndRefreshMemory(input: {
    userId: string;
    sessionId: string;
    userText: string;
    assistantText: string;
    existingSummary: string;
  }): Promise<void> {
    this.store.appendMessage(input.sessionId, "user", input.userText);
    this.store.appendMessage(input.sessionId, "assistant", input.assistantText);

    try {
      const refreshedHistory = this.store.listSessionMessages(input.sessionId, 12).map((message) => ({
        role: message.role,
        text: message.text
      }));
      const updated = await runMemoryUpdate(this.client, {
        existingSummary: input.existingSummary,
        recentMessages: refreshedHistory.slice(-6)
      });

      this.store.updateRollingSummary(input.sessionId, updated.rollingSummary);
      const replacements: NewMemoryInput[] = updated.longTerm.map((item) => ({
        userId: input.userId,
        kind: item.kind,
        text: item.text,
        importance: item.importance,
        confidence: item.confidence,
        sourceSessionId: input.sessionId
      }));
      if (replacements.length > 0) {
        this.store.replaceLongTermMemories(input.userId, replacements);
      }
    } catch {
      // Keep previous memory state on extraction/update errors.
    }
  }

  private async tryRouterDecision(userText: string): Promise<RouterDecision | null> {
    try {
      return await runRouter(this.client, {
        model: "gpt-5-mini",
        instructions: ROUTER_INSTRUCTIONS,
        userText
      });
    } catch {
      return null;
    }
  }
}

function formatModeOutput(input: {
  mode: LLMTask["mode"];
  persona: LLMTask["persona"] | undefined;
  text: string;
  fallback: string;
}): string {
  if (input.mode === "SINGLE") {
    return formatSingleResponse(input.persona ?? "yan", input.text);
  }
  if (input.mode === "SUMMARY") {
    return formatSummaryResponse(input.text);
  }
  const panelCandidate = input.text.trim();
  if (!validatePanelFormat(panelCandidate).valid) {
    return input.fallback;
  }
  return panelCandidate;
}

function buildFallbackTextForMode(
  mode: LLMTask["mode"],
  persona: LLMTask["persona"] | undefined
): string {
  if (mode === "SINGLE") {
    return formatSingleFallback(persona ?? "yan");
  }
  if (mode === "SUMMARY") {
    return formatSummaryFallback();
  }
  return formatPanelFallback();
}

function buildMemoryBlock(state: MemoryState): string {
  const longTerm = state.longTerm
    .slice(0, 5)
    .map((item) => `- [${item.kind}] ${item.text} (imp:${item.importance}, conf:${item.confidence.toFixed(2)})`)
    .join("\n");
  const history = state.history
    .slice(-6)
    .map((turn) => `${turn.role.toUpperCase()}: ${turn.text}`)
    .join("\n");

  return [
    `ROLLING_SUMMARY:\n${state.rollingSummary || "(empty)"}`,
    `LONG_TERM:\n${longTerm || "(none)"}`,
    `RECENT_TURNS:\n${history || "(none)"}`
  ].join("\n\n");
}
