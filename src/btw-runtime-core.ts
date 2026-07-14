import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Extension,
  ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import {
  buildSessionContext,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { type Api, type AssistantMessage, type Message, type Model, type ThinkingLevel as AiThinkingLevel, type UserMessage } from "@earendil-works/pi-ai";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import type { BtwAgentDefinition } from "./agent-discovery";
import {
  ASIDE_COMMAND_DESCRIPTION,
  ASIDE_COMMAND_NAME,
  parseAsideCommandArgs,
  parseAsideSlashCommand,
} from "./aside-command";
import type { BtwConfig, BtwModalSize } from "./config";
import { resolveBtwIcons, resolveBtwAgentIcon, type BtwIconSet } from "./icons";
import { isRecord } from "./record-utils";
import { adaptModelRegistryForAgentSession, resolveModelRequestAuth } from "./model-registry-compat";
import { getNumericUsageField } from "./btw-usage";
import type { BtwTranscript, BtwTranscriptEntry } from "./btw-types";

const BTW_MESSAGE_TYPE = "btw-note";
const BTW_ENTRY_TYPE = "btw-thread-entry";
const BTW_RESET_TYPE = "btw-thread-reset";
const BTW_MODEL_OVERRIDE_TYPE = "btw-model-override";
const BTW_THINKING_OVERRIDE_TYPE = "btw-thinking-override";
const BTW_AGENT_SELECTION_TYPE = "btw-agent-selection";
const BTW_FOCUS_SHORTCUTS = ["alt+/", "ctrl+alt+w"] as const;

const DEFAULT_TERMINAL_COLUMNS = 120;
const DEFAULT_TERMINAL_ROWS = 36;
const BTW_MODAL_MARGIN = 1;
const BTW_MODAL_SIZE_PRESETS: Record<
  BtwModalSize,
  { widthRatio: number; heightRatio: number; minWidth: number; maxWidth: number; minRows: number }
> = {
  small: { widthRatio: 0.64, heightRatio: 0.58, minWidth: 56, maxWidth: 96, minRows: 14 },
  medium: { widthRatio: 0.78, heightRatio: 0.78, minWidth: 72, maxWidth: 132, minRows: 18 },
  large: { widthRatio: 0.92, heightRatio: 0.94, minWidth: 80, maxWidth: 200, minRows: 22 },
};

function safePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function clampResponsiveTarget(preferred: number, configuredMinimum: number, configuredMaximum: number, available: number): number {
  const minimum = Math.min(configuredMinimum, available);
  return Math.max(1, Math.min(configuredMaximum, available, Math.max(minimum, preferred)));
}

export function resolveBtwModalDimensions(
  tui: Pick<TUI, "terminal"> | undefined,
  modalSize: BtwModalSize,
): { anchor: "center"; width: number; maxHeight: number; margin: typeof BTW_MODAL_MARGIN; nonCapturing: true } {
  const preset = BTW_MODAL_SIZE_PRESETS[modalSize] ?? BTW_MODAL_SIZE_PRESETS.medium;
  const columns = safePositiveInteger(tui?.terminal?.columns, DEFAULT_TERMINAL_COLUMNS);
  const rows = safePositiveInteger(tui?.terminal?.rows, DEFAULT_TERMINAL_ROWS);
  const availableWidth = Math.max(24, columns - BTW_MODAL_MARGIN * 2);
  const availableRows = Math.max(9, rows - BTW_MODAL_MARGIN * 2);
  const preferredWidth = Math.floor(columns * preset.widthRatio);
  const preferredRows = Math.floor(rows * preset.heightRatio);

  return {
    width: clampResponsiveTarget(preferredWidth, preset.minWidth, preset.maxWidth, availableWidth),
    maxHeight: clampResponsiveTarget(preferredRows, preset.minRows, Number.MAX_SAFE_INTEGER, availableRows),
    anchor: "center",
    margin: BTW_MODAL_MARGIN,
    nonCapturing: true,
  };
}

const DEFAULT_BTW_AGENT_NAME = "code";

const BTW_SUMMARIZE_SYSTEM_PROMPT =
  "Summarize the side conversation concisely. Preserve key decisions, plans, insights, risks, and action items. Output only the summary.";

const BTW_CHAT_ONLY_SYSTEM_PROMPT =
  "BTW sidecar chat mode:\n" +
  "- Stay in a normal chat-only side conversation.\n" +
  "- Use only the provided user and assistant conversation messages as context.\n" +
  "- Do not perform external actions, request external actions, or describe external-action workflows.\n" +
  "- If the provided conversation context is insufficient, ask a normal follow-up question.";

const BTW_AGENT_PROMPT_XML_BLOCKS_TO_REMOVE = [
  "quick_reference",
  "constraints",
  "core_principles",
  "understand_intent",
  "do_only_what_asked",
  "project_setup_behavior",
  "safety",
  "output_format",
  "delegated_task_response",
  "mandatory_elements",
  "forbidden_shortcuts",
  "mcp_tools_usage",
  "skills_access",
  "instructions",
  "primary_workflow",
  "phase_0_mandatory_context_ingestion",
  "fast_path",
  "request_classification",
  "ambiguity_handling",
  "challenge_user_when_appropriate",
  "evidence_requirements",
  "failure_recovery",
  "coding_standards",
  "project_conventions",
  "quality_requirements",
  "verification_selection",
  "anti_patterns",
  "security_awareness",
  "examples",
  "final_directive",
] as const;
const BTW_AGENT_PROMPT_MARKDOWN_SECTION_PATTERN = /^(tools?|mcp|skills?|permissions?|verification|evidence|commands?)\b/i;

const BTW_CONTINUE_THREAD_USER_TEXT = "[The following is a separate side conversation. Continue this thread.]";
const BTW_CONTINUE_THREAD_ASSISTANT_TEXT = "Understood, continuing our side conversation.";

type SessionThinkingLevel = "off" | AiThinkingLevel;
type BtwThreadMode = "contextual" | "tangent";
type SessionModel = Model<Api>;
/**
 * Loose model reference parsed from `/aside model <provider> <id> <api>` and persisted to
 * session entries. Resolved to a full SessionModel via ctx.modelRegistry.find(...).
 */
type BtwModelRef = Pick<SessionModel, "provider" | "id" | "api">;

type BtwDetails = {
  question: string;
  thinking: string;
  answer: string;
  provider: string;
  model: string;
  api: string;
  thinkingLevel: SessionThinkingLevel;
  timestamp: number;
  usage?: AssistantMessage["usage"];
};

type ParsedBtwArgs = {
  question: string;
  save: boolean;
};

type SaveState = "not-saved" | "saved" | "queued";

type BtwResetDetails = {
  timestamp: number;
  mode?: BtwThreadMode;
};

type BtwModelOverrideDetails =
  | ({ timestamp: number; action: "set" } & Pick<SessionModel, "provider" | "id" | "api">)
  | { timestamp: number; action: "clear" };

type BtwThinkingOverrideDetails =
  | { timestamp: number; action: "set"; thinkingLevel: SessionThinkingLevel }
  | { timestamp: number; action: "clear" };

type BtwAgentSelectionDetails = {
  timestamp: number;
  name: string;
};

type BtwModelSource = "override" | "agent" | "main" | "none";
type BtwThinkingSource = "override" | "agent" | "main";

type ResolvedBtwModel = {
  model: SessionModel | null;
  source: BtwModelSource;
  configuredOverride: SessionModel | null;
  agentModelReference?: string;
  fallbackReason?: string;
};

type ResolvedBtwSettings = {
  model: SessionModel | null;
  modelSource: BtwModelSource;
  configuredModelOverride: SessionModel | null;
  agentModelReference?: string;
  thinkingLevel: SessionThinkingLevel;
  thinkingSource: BtwThinkingSource;
  temperature?: number;
  fallbackReason?: string;
};

type BtwTranscriptState = {
  entries: BtwTranscript;
  nextEntryId: number;
  nextTurnId: number;
  currentTurnId: number | null;
  lastTurnId: number | null;
  toolCalls: Map<string, { turnId: number; callEntryId: number; resultEntryId?: number }>;
};

type BtwSessionRuntime = {
  session: AgentSession;
  mode: BtwThreadMode;
  agentName: string;
  modelKey: string;
  modelSource: BtwModelSource;
  thinkingLevel: SessionThinkingLevel;
  thinkingSource: BtwThinkingSource;
  subscriptions: Set<() => void>;
  sideThreadStartIndex: number;
};

type ToolControllableSession = {
  setActiveToolsByName?: (toolNames: string[]) => void | Promise<void>;
};

type OverlayRuntime = {
  handle?: OverlayHandle;
  refresh?: () => void;
  close?: () => void;
  finish?: () => void;
  setDraft?: (value: string) => void;
  enterInjectSelect?: (instructions: string) => void;
  exitInjectSelect?: () => void;
  closed?: boolean;
};

function isCustomEntry(entry: unknown, customType: string): entry is { type: "custom"; customType: string; data?: unknown } {
  return !!entry && typeof entry === "object" && (entry as { type?: string }).type === "custom" && (entry as { customType?: string }).customType === customType;
}

async function disableSessionTools(session: AgentSession): Promise<void> {
  const setActiveToolsByName = (session as unknown as ToolControllableSession).setActiveToolsByName;
  if (typeof setActiveToolsByName === "function") {
    await setActiveToolsByName.call(session, []);
  }
}

async function createBtwResourceLoader(
  ctx: ExtensionCommandContext,
  appendSystemPrompt: string[] = [],
  extensions: Extension[] = [],
): Promise<ResourceLoader> {
  // Use the host SDK's loader instead of constructing its private extension
  // runtime shape. Pi and OMP both expose this compatibility surface, while
  // their internal ExtensionRuntime implementations have diverged.
  const loader = new DefaultResourceLoader({
    cwd: ctx.cwd || process.cwd(),
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: BTW_CHAT_ONLY_SYSTEM_PROMPT,
    appendSystemPrompt,
    extensionsOverride: (base) => ({
      ...base,
      extensions: [...base.extensions, ...extensions],
    }),
  });
  await loader.reload();
  return loader;
}

function getFirstStringField(record: Record<string, unknown>, fieldNames: string[]): string {
  for (const fieldName of fieldNames) {
    const value = record[fieldName];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return "";
}

function extractText(parts: AssistantMessage["content"], type: "text" | "thinking"): string {
  const chunks: string[] = [];

  for (const part of parts as unknown as Array<Record<string, unknown>>) {
    const partType = typeof part.type === "string" ? part.type : "";
    if (type === "text" && partType === "text") {
      const text = getFirstStringField(part, ["text"]);
      if (text) {
        chunks.push(text);
      }
      continue;
    }

    if (type === "thinking") {
      const reasoning = getFirstStringField(part, ["thinking", "reasoning", "reasoningContent", "reasoning_content", "text"]);
      if (reasoning && (partType === "thinking" || partType === "reasoning" || "reasoningContent" in part || "reasoning_content" in part)) {
        chunks.push(reasoning);
      }
    }
  }

  return chunks.join("\n").trim();
}

function extractAnswer(message: AssistantMessage): string {
  return extractText(message.content, "text") || "(No text response)";
}

function extractThinking(message: AssistantMessage): string {
  return extractText(message.content, "thinking");
}

function parseBtwArgs(args: string): ParsedBtwArgs {
  const save = /(?:^|\s)(?:--save|-s)(?=\s|$)/.test(args);
  const question = args.replace(/(?:^|\s)(?:--save|-s)(?=\s|$)/g, " ").trim();
  return { question, save };
}

function parseBtwOverrideAction(args: string):
  | { action: "show" }
  | { action: "clear" }
  | { action: "set"; trimmed: string } {
  const trimmed = args.trim();
  if (!trimmed) {
    return { action: "show" };
  }
  if (trimmed === "clear") {
    return { action: "clear" };
  }
  return { action: "set", trimmed };
}

function parseBtwModelArgs(args: string):
  | { action: "show" }
  | { action: "clear" }
  | { action: "set"; model: BtwModelRef }
  | { action: "invalid"; message: string } {
  const parsed = parseBtwOverrideAction(args);
  if (parsed.action !== "set") {
    return parsed;
  }

  const parts = parsed.trimmed.split(/\s+/);
  if (parts.length !== 3) {
    return { action: "invalid", message: "Usage: /aside model <provider> <model> <api> | clear" };
  }

  const [provider, id, api] = parts;
  return { action: "set", model: { provider, id, api } as BtwModelRef };
}

function parseBtwThinkingArgs(args: string):
  | { action: "show" }
  | { action: "clear" }
  | { action: "set"; thinkingLevel: SessionThinkingLevel } {
  const parsed = parseBtwOverrideAction(args);
  if (parsed.action !== "set") {
    return parsed;
  }

  return { action: "set", thinkingLevel: parsed.trimmed as SessionThinkingLevel };
}

function formatModelRef(model: Pick<SessionModel, "provider" | "id" | "api">): string {
  return `${model.provider}/${model.id} (${model.api})`;
}

function parseModelReference(modelReference: string | undefined): { provider: string; modelId: string } | undefined {
  const trimmed = modelReference?.trim();
  if (!trimmed) {
    return undefined;
  }

  const separatorIndex = trimmed.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    return undefined;
  }

  return {
    provider: trimmed.slice(0, separatorIndex),
    modelId: trimmed.slice(separatorIndex + 1),
  };
}

function isSessionModel(value: unknown): value is SessionModel {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { provider?: unknown }).provider === "string" &&
      typeof (value as { id?: unknown }).id === "string" &&
      typeof (value as { api?: unknown }).api === "string",
  );
}

function getMainModel(ctx: ExtensionCommandContext | ExtensionContext | null | undefined): Model<Api> | undefined {
  const direct = ctx?.model as Model<Api> | undefined;
  if (direct) {
    return direct;
  }

  const models = (ctx as unknown as { models?: { current?: () => unknown } } | null | undefined)?.models;
  if (typeof models?.current !== "function") {
    return undefined;
  }

  try {
    const current = models.current();
    return isSessionModel(current) ? current : undefined;
  } catch {
    return undefined;
  }
}

function getRegistryModels(ctx: ExtensionCommandContext, method: "getAvailable" | "getAll"): SessionModel[] {
  const registry = ctx.modelRegistry as unknown as Record<string, (() => unknown) | undefined>;
  const loader = registry[method];
  if (typeof loader !== "function") {
    return [];
  }

  try {
    const models = loader.call(ctx.modelRegistry);
    return Array.isArray(models) ? models.filter(isSessionModel) : [];
  } catch {
    return [];
  }
}

function resolveModelReference(ctx: ExtensionCommandContext, requested: string | undefined): { model: SessionModel | null; requested?: string } {
  const trimmed = requested?.trim();
  if (!trimmed) {
    return { model: null };
  }

  const modelQuery = (ctx as unknown as { models?: { resolve?: (spec: string) => unknown } }).models;
  if (typeof modelQuery?.resolve === "function") {
    try {
      const resolved = modelQuery.resolve(trimmed);
      if (isSessionModel(resolved)) {
        return { model: resolved, requested: trimmed };
      }
    } catch {
      // Fall through to the older registry API.
    }
  }

  const parsed = parseModelReference(trimmed);
  if (parsed) {
    const exact = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
    if (isSessionModel(exact)) {
      return { model: exact, requested: trimmed };
    }

    const byId = [...getRegistryModels(ctx, "getAvailable"), ...getRegistryModels(ctx, "getAll")].find(
      (model) => model.id === parsed.modelId,
    );
    return { model: byId ?? null, requested: trimmed };
  }

  const models = [...getRegistryModels(ctx, "getAvailable"), ...getRegistryModels(ctx, "getAll")];
  const byReference = models.find((model) => `${model.provider}/${model.id}` === trimmed);
  if (byReference) {
    return { model: byReference, requested: trimmed };
  }

  const byId = models.find((model) => model.id === trimmed);
  return { model: byId ?? null, requested: trimmed };
}

function shouldSkipTemperatureExtension(model: SessionModel): boolean {
  const api = String(model.api);
  const id = String(model.id).split("/").pop()?.toLowerCase() || String(model.id).toLowerCase();
  if (!["azure-openai-responses", "openai-codex-responses", "openai-completions", "openai-responses"].includes(api)) {
    return false;
  }

  if (id.startsWith("gpt-5-chat")) {
    return false;
  }

  return Boolean(
    (model as { reasoning?: unknown }).reasoning ||
      /^o\d(?:$|[-.])/.test(id) ||
      /^gpt-5(?:$|[-.])/.test(id) ||
      /(?:^|[-.])codex(?:$|[-.])/.test(id),
  );
}

function shouldUseOpenAiCompatibleProxySafeCompat(model: SessionModel): boolean {
  const provider = String(model.provider).toLowerCase();
  const baseUrl = String((model as { baseUrl?: unknown }).baseUrl ?? "").toLowerCase();
  const compat = (model as { compat?: Record<string, unknown> }).compat;

  return Boolean(
    model.api === "openai-completions" &&
      (provider === "gitlawb-opengateway" ||
        baseUrl.includes("opengateway.gitlawb.com") ||
        typeof compat?.interleavedReasoningField === "string"),
  );
}

function prepareBtwSessionModel(model: SessionModel): SessionModel {
  if (!shouldUseOpenAiCompatibleProxySafeCompat(model)) {
    return model;
  }

  return {
    ...model,
    compat: {
      ...(model as { compat?: Record<string, unknown> }).compat,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStore: false,
      supportsStrictMode: false,
      maxTokensField: "max_tokens",
    },
  } as SessionModel;
}

function normalizeBtwUsage(usage: unknown): AssistantMessage["usage"] {
  const input = getNumericUsageField(usage, ["input", "inputTokens", "promptTokens", "prompt_tokens"]) ?? 0;
  const output = getNumericUsageField(usage, ["output", "outputTokens", "completionTokens", "completion_tokens"]) ?? 0;
  const cacheRead = getNumericUsageField(usage, ["cacheRead", "cache_read", "cachedTokens", "cached_tokens"]) ?? 0;
  const cacheWrite = getNumericUsageField(usage, ["cacheWrite", "cache_write"]) ?? 0;
  const total = getNumericUsageField(usage, ["totalTokens", "total", "total_tokens"]) ?? input + output + cacheRead + cacheWrite;
  const cost = isRecord(usage) && isRecord(usage.cost) ? usage.cost : undefined;
  const costInput = getNumericUsageField(cost, ["input"]) ?? 0;
  const costOutput = getNumericUsageField(cost, ["output"]) ?? 0;
  const costCacheRead = getNumericUsageField(cost, ["cacheRead", "cache_read"]) ?? 0;
  const costCacheWrite = getNumericUsageField(cost, ["cacheWrite", "cache_write"]) ?? 0;
  const costTotal = getNumericUsageField(cost, ["total"]) ?? costInput + costOutput + costCacheRead + costCacheWrite;

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: total,
    cost: {
      input: costInput,
      output: costOutput,
      cacheRead: costCacheRead,
      cacheWrite: costCacheWrite,
      total: costTotal,
    },
  } as AssistantMessage["usage"];
}

function ensureBtwAssistantMessageUsage(message: AssistantMessage): AssistantMessage {
  message.usage = normalizeBtwUsage(message.usage);
  return message;
}

function createTemperatureExtension(temperature: number, model: SessionModel): Extension | undefined {
  if (!Number.isFinite(temperature) || shouldSkipTemperatureExtension(model)) {
    return undefined;
  }

  const extensionPath = "pi-btw-sidecar:inline-temperature";
  return {
    path: extensionPath,
    resolvedPath: extensionPath,
    sourceInfo: { kind: "extension", path: extensionPath },
    handlers: new Map([
      [
        "before_provider_request",
        [
          (event: { payload: unknown }) => {
            if (!isRecord(event.payload)) {
              return undefined;
            }

            return { ...event.payload, temperature };
          },
        ],
      ],
    ]),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  } as unknown as Extension;
}

function normalizePromptWhitespace(value: string): string {
  return value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripTaggedPromptBlocks(prompt: string, tags: readonly string[]): string {
  let sanitized = prompt;
  for (const tag of tags) {
    sanitized = sanitized.replace(new RegExp(`\\n?\\s*<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>\\s*\\n?`, "gi"), "\n\n");
  }
  return sanitized;
}

function stripMarkdownPromptSections(prompt: string): string {
  const lines = prompt.split("\n");
  const keptLines: string[] = [];
  let skippedHeadingLevel: number | null = null;

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const headingLevel = heading[1].length;
      const headingTitle = heading[2].replace(/[`*_]/g, "").trim();
      if (skippedHeadingLevel !== null && headingLevel <= skippedHeadingLevel) {
        skippedHeadingLevel = null;
      }
      if (skippedHeadingLevel === null && BTW_AGENT_PROMPT_MARKDOWN_SECTION_PATTERN.test(headingTitle)) {
        skippedHeadingLevel = headingLevel;
        continue;
      }
    }

    if (skippedHeadingLevel !== null) {
      continue;
    }

    keptLines.push(line);
  }

  return keptLines.join("\n");
}

function extractTaggedPromptBlock(prompt: string, tag: string): string | null {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(prompt);
  return match ? `<${tag}>${match[1]}</${tag}>` : null;
}

function sanitizeBtwChatOnlyPrompt(prompt: string): string {
  return normalizePromptWhitespace(
    prompt
      .replace(/\bexecute commands\b/gi, "answer conversationally")
      .replace(/\bexecuting commands\b/gi, "answering conversationally")
      .replace(/\buse tools?\b/gi, "answer conversationally")
      .replace(/\busing tools?\b/gi, "answering conversationally"),
  );
}

function sanitizeBtwAgentSystemPrompt(systemPrompt: string): string {
  const strippedOperationalPrompt = stripMarkdownPromptSections(
    stripTaggedPromptBlocks(systemPrompt, BTW_AGENT_PROMPT_XML_BLOCKS_TO_REMOVE),
  );
  const rolePrompt = extractTaggedPromptBlock(strippedOperationalPrompt, "role") ?? strippedOperationalPrompt;
  const sanitizedRolePrompt = sanitizeBtwChatOnlyPrompt(rolePrompt);
  return sanitizedRolePrompt;
}

function createBtwSessionExtensions(settings: ResolvedBtwSettings): Extension[] {
  if (settings.temperature === undefined || !settings.model) {
    return [];
  }

  const extension = createTemperatureExtension(settings.temperature, settings.model);
  return extension ? [extension] : [];
}

function sanitizeBtwContextSeedMessage(message: Message): Message | null {
  const role = (message as { role?: unknown }).role;
  if (role !== "user" && role !== "assistant") {
    return null;
  }

  const text = extractMessageText(
    message as { content?: string | AssistantMessage["content"] | UserMessage["content"] },
  ).trim();
  if (!text) {
    return null;
  }

  const timestamp = typeof (message as { timestamp?: unknown }).timestamp === "number" ? (message as { timestamp: number }).timestamp : Date.now();
  if (role === "assistant") {
    const assistant = message as Partial<AssistantMessage>;
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      provider: typeof assistant.provider === "string" && assistant.provider ? assistant.provider : "unknown",
      model: typeof assistant.model === "string" && assistant.model ? assistant.model : "unknown",
      api: typeof assistant.api === "string" && assistant.api ? assistant.api : "openai-responses",
      usage: normalizeBtwUsage(assistant.usage),
      stopReason: "stop",
      timestamp,
    } as Message;
  }

  return {
    role,
    content: [{ type: "text", text }],
    timestamp,
  } as Message;
}

function sanitizeBtwContextSeedMessages(messages: Message[]): Message[] {
  const sanitizedMessages: Message[] = [];
  for (const message of messages) {
    const sanitized = sanitizeBtwContextSeedMessage(message);
    if (sanitized) {
      sanitizedMessages.push(sanitized);
    }
  }

  return sanitizedMessages;
}

async function buildBtwSeedState(
  ctx: ExtensionCommandContext,
  thread: BtwDetails[],
  mode: BtwThreadMode,
  sessionModel: SessionModel | null,
): Promise<{ messages: Message[]; sideThreadStartIndex: number }> {
  const messages: Message[] = [];

  if (mode === "contextual") {
    try {
      const contextMessages = sanitizeBtwContextSeedMessages(
        buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages as Message[],
      );
      if (contextMessages.length === 0 && ctx.sessionManager.getEntries().some((entry) => !!entry && typeof entry === "object" && typeof (entry as { role?: unknown }).role === "string")) {
        throw new Error("Session context builder returned no message entries.");
      }
      messages.push(...contextMessages);
    } catch {
      messages.push(
        ...ctx.sessionManager.getEntries().flatMap((entry) => {
          if (!entry || typeof entry !== "object") {
            return [];
          }

          const message = entry as unknown as Partial<Message> & { role?: string; customType?: string; content?: unknown };
          if (typeof message.role !== "string" || !Array.isArray(message.content)) {
            return [];
          }

          const sanitized = sanitizeBtwContextSeedMessage(message as Message);
          return sanitized ? [sanitized] : [];
        }),
      );
    }
  }

  const sideThreadStartIndex = messages.length;

  if (thread.length > 0) {
    messages.push(
      {
        role: "user",
        content: [{ type: "text", text: BTW_CONTINUE_THREAD_USER_TEXT }],
        timestamp: Date.now(),
      },
      {
        role: "assistant",
        content: [{ type: "text", text: BTW_CONTINUE_THREAD_ASSISTANT_TEXT }],
        provider: sessionModel?.provider ?? "unknown",
        model: sessionModel?.id ?? "unknown",
        api: sessionModel?.api ?? "openai-responses",
        usage: normalizeBtwUsage(undefined),
        stopReason: "stop",
        timestamp: Date.now(),
      },
    );

    for (const entry of thread) {
      messages.push(
        {
          role: "user",
          content: [{ type: "text", text: entry.question }],
          timestamp: entry.timestamp,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: entry.answer }],
          provider: entry.provider,
          model: entry.model,
          api: entry.api || sessionModel?.api || getMainModel(ctx)?.api || "openai-responses",
          usage: normalizeBtwUsage(entry.usage),
          stopReason: "stop",
          timestamp: entry.timestamp,
        },
      );
    }
  }

  return {
    messages,
    sideThreadStartIndex,
  };
}

function formatToolPreview(value: unknown): string {
  if (value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    const path = (value as { path?: unknown }).path;
    if (typeof path === "string") {
      return path;
    }
  }

  try {
    const preview = JSON.stringify(value);
    if (!preview || preview === "{}") {
      return "";
    }
    return preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
  } catch {
    return "";
  }
}

function createEmptyTranscriptState(): BtwTranscriptState {
  return {
    entries: [],
    nextEntryId: 1,
    nextTurnId: 1,
    currentTurnId: null,
    lastTurnId: null,
    toolCalls: new Map(),
  };
}

function appendTranscriptEntry<T extends BtwTranscriptEntry>(
  state: BtwTranscriptState,
  entry: Omit<T, "id">,
): T {
  const nextEntry = { ...entry, id: state.nextEntryId++ } as T;
  state.entries.push(nextEntry);
  return nextEntry;
}

function ensureTranscriptTurn(state: BtwTranscriptState): number {
  if (state.currentTurnId !== null) {
    return state.currentTurnId;
  }

  const turnId = state.nextTurnId++;
  state.currentTurnId = turnId;
  state.lastTurnId = turnId;
  appendTranscriptEntry(state, { type: "turn-boundary", turnId, phase: "start" } as Omit<Extract<BtwTranscriptEntry, { type: "turn-boundary" }>, "id">);
  return turnId;
}

function finishTranscriptTurn(state: BtwTranscriptState, turnId?: number | null): void {
  const resolvedTurnId = turnId ?? state.currentTurnId;
  if (resolvedTurnId === null || resolvedTurnId === undefined) {
    return;
  }

  const hasEndBoundary = state.entries.some(
    (entry) => entry.turnId === resolvedTurnId && entry.type === "turn-boundary" && entry.phase === "end",
  );
  if (!hasEndBoundary) {
    appendTranscriptEntry(state, { type: "turn-boundary", turnId: resolvedTurnId, phase: "end" } as Omit<Extract<BtwTranscriptEntry, { type: "turn-boundary" }>, "id">);
  }

  for (const entry of state.entries) {
    if (entry.turnId !== resolvedTurnId) {
      continue;
    }

    if (entry.type === "thinking" || entry.type === "assistant-text" || entry.type === "tool-result") {
      entry.streaming = false;
    }
  }

  state.lastTurnId = resolvedTurnId;
  if (state.currentTurnId === resolvedTurnId) {
    state.currentTurnId = null;
  }
}

function removeTranscriptTurn(state: BtwTranscriptState, turnId: number | null): void {
  if (turnId === null) {
    return;
  }

  state.entries = state.entries.filter((entry) => entry.turnId !== turnId);
  for (const [toolCallId, toolCall] of state.toolCalls.entries()) {
    if (toolCall.turnId === turnId) {
      state.toolCalls.delete(toolCallId);
    }
  }

  if (state.currentTurnId === turnId) {
    state.currentTurnId = null;
  }
  if (state.lastTurnId === turnId) {
    state.lastTurnId = null;
  }
}

function findLatestTranscriptEntry<TType extends BtwTranscriptEntry["type"]>(
  state: BtwTranscriptState,
  turnId: number,
  type: TType,
): Extract<BtwTranscriptEntry, { type: TType }> | undefined {
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const entry = state.entries[i];
    if (entry.turnId === turnId && entry.type === type) {
      return entry as Extract<BtwTranscriptEntry, { type: TType }>;
    }
  }

  return undefined;
}

function ensureTranscriptTurnForUserMessage(state: BtwTranscriptState): number {
  if (state.currentTurnId !== null) {
    const currentAssistant = findLatestTranscriptEntry(state, state.currentTurnId, "assistant-text");
    if (currentAssistant && !currentAssistant.streaming) {
      finishTranscriptTurn(state, state.currentTurnId);
    }
  }

  return ensureTranscriptTurn(state);
}

function extractMessageText(message: { content?: string | AssistantMessage["content"] | UserMessage["content"] }): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function upsertUserMessageEntry(state: BtwTranscriptState, turnId: number, text: string): void {
  if (!text) {
    return;
  }

  const existing = findLatestTranscriptEntry(state, turnId, "user-message");
  if (existing) {
    existing.text = text;
    return;
  }

  appendTranscriptEntry(state, { type: "user-message", turnId, text } as Omit<Extract<BtwTranscriptEntry, { type: "user-message" }>, "id">);
}

function upsertTranscriptTextEntry(
  state: BtwTranscriptState,
  turnId: number,
  type: "thinking" | "assistant-text",
  text: string,
  streaming: boolean,
): void {
  if (!text) {
    return;
  }

  const existing = findLatestTranscriptEntry(state, turnId, type);
  if (existing) {
    existing.text = text;
    existing.streaming = streaming;
    return;
  }

  appendTranscriptEntry(state, { type, turnId, text, streaming } as Omit<Extract<BtwTranscriptEntry, { type: "thinking" | "assistant-text" }>, "id">);
}

function summarizeToolResult(value: unknown, maxLength = 400): { content: string; truncated: boolean } {
  let content = "";

  if (value && typeof value === "object") {
    const toolValue = value as {
      content?: Array<{ type?: string; text?: string }>;
      error?: unknown;
      message?: unknown;
    };

    if (Array.isArray(toolValue.content)) {
      content = toolValue.content
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();
    }

    if (!content && typeof toolValue.error === "string") {
      content = toolValue.error;
    }

    if (!content && typeof toolValue.message === "string") {
      content = toolValue.message;
    }
  }

  if (!content) {
    if (typeof value === "string") {
      content = value;
    } else if (value !== undefined) {
      try {
        content = JSON.stringify(value, null, 2);
      } catch {
        content = String(value);
      }
    }
  }

  if (!content) {
    content = "(no tool output)";
  }

  const truncated = content.length > maxLength;
  return {
    content: truncated ? `${content.slice(0, maxLength - 3)}...` : content,
    truncated,
  };
}

function ensureToolCallEntry(
  state: BtwTranscriptState,
  turnId: number,
  toolCallId: string,
  toolName: string,
  args: string,
): { turnId: number; callEntryId: number; resultEntryId?: number } {
  const existing = state.toolCalls.get(toolCallId);
  if (existing) {
    return existing;
  }

  const callEntry = appendTranscriptEntry(state, {
    type: "tool-call",
    turnId,
    toolCallId,
    toolName,
    args,
  } as Omit<Extract<BtwTranscriptEntry, { type: "tool-call" }>, "id">);
  const record = { turnId, callEntryId: callEntry.id };
  state.toolCalls.set(toolCallId, record);
  return record;
}

function upsertToolResultEntry(
  state: BtwTranscriptState,
  turnId: number,
  toolCallId: string,
  toolName: string,
  content: string,
  truncated: boolean,
  isError: boolean,
  streaming: boolean,
): void {
  const toolCall = ensureToolCallEntry(state, turnId, toolCallId, toolName, "");
  const existing =
    toolCall.resultEntryId !== undefined
      ? state.entries.find((entry) => entry.id === toolCall.resultEntryId && entry.type === "tool-result")
      : undefined;

  if (existing && existing.type === "tool-result") {
    existing.content = content;
    existing.truncated = truncated;
    existing.isError = isError;
    existing.streaming = streaming;
    return;
  }

  const resultEntry = appendTranscriptEntry(state, {
    type: "tool-result",
    turnId,
    toolCallId,
    toolName,
    content,
    truncated,
    isError,
    streaming,
  } as Omit<Extract<BtwTranscriptEntry, { type: "tool-result" }>, "id">);
  toolCall.resultEntryId = resultEntry.id;
}

function applyAssistantMessageToTranscript(
  state: BtwTranscriptState,
  turnId: number,
  message: AssistantMessage,
  streaming: boolean,
): void {
  const assistantMessage = message;
  const thinking = extractThinking(assistantMessage);
  const answer = extractMessageText(assistantMessage);

  if (thinking) {
    upsertTranscriptTextEntry(state, turnId, "thinking", thinking, streaming);
  }

  if (answer) {
    upsertTranscriptTextEntry(state, turnId, "assistant-text", answer, streaming);
  }
}

function applyTranscriptEvent(state: BtwTranscriptState, event: AgentSessionEvent): void {
  type SessionMessage = Extract<AgentSessionEvent, { type: "message_start" }>["message"];
  const handleMessage = (message: SessionMessage, streaming: boolean): void => {
    if (message.role === "user") {
      const turnId = ensureTranscriptTurnForUserMessage(state);
      upsertUserMessageEntry(state, turnId, extractMessageText(message));
      return;
    }
    if (message.role === "assistant") {
      const turnId = ensureTranscriptTurn(state);
      applyAssistantMessageToTranscript(state, turnId, message, streaming);
    }
  };

  switch (event.type) {
    case "turn_start": {
      ensureTranscriptTurn(state);
      return;
    }
    case "message_start": {
      handleMessage(event.message, true);
      return;
    }
    case "message_update": {
      if (event.message.role !== "assistant") {
        return;
      }

      const turnId = ensureTranscriptTurn(state);
      applyAssistantMessageToTranscript(state, turnId, event.message, true);
      return;
    }
    case "message_end": {
      handleMessage(event.message, false);
      return;
    }
    case "tool_execution_start": {
      const turnId = ensureTranscriptTurn(state);
      ensureToolCallEntry(state, turnId, event.toolCallId, event.toolName, formatToolPreview(event.args));
      return;
    }
    case "tool_execution_update": {
      const turnId = state.toolCalls.get(event.toolCallId)?.turnId ?? ensureTranscriptTurn(state);
      const result = summarizeToolResult(event.partialResult);
      upsertToolResultEntry(
        state,
        turnId,
        event.toolCallId,
        event.toolName,
        result.content,
        result.truncated,
        false,
        true,
      );
      return;
    }
    case "tool_execution_end": {
      const turnId = state.toolCalls.get(event.toolCallId)?.turnId ?? ensureTranscriptTurn(state);
      const result = summarizeToolResult(event.result);
      upsertToolResultEntry(
        state,
        turnId,
        event.toolCallId,
        event.toolName,
        result.content,
        result.truncated,
        event.isError,
        false,
      );
      return;
    }
    case "turn_end": {
      finishTranscriptTurn(state);
      return;
    }
    default:
      return;
  }
}

function appendPersistedTranscriptTurn(state: BtwTranscriptState, details: BtwDetails): void {
  const turnId = ensureTranscriptTurn(state);
  upsertUserMessageEntry(state, turnId, details.question);
  if (details.thinking) {
    upsertTranscriptTextEntry(state, turnId, "thinking", details.thinking, false);
  }
  upsertTranscriptTextEntry(state, turnId, "assistant-text", details.answer, false);
  finishTranscriptTurn(state, turnId);
}

function setTranscriptFailure(state: BtwTranscriptState, message: string, icons: BtwIconSet): void {
  const turnId = state.currentTurnId ?? state.lastTurnId ?? ensureTranscriptTurn(state);
  upsertTranscriptTextEntry(state, turnId, "assistant-text", `${icons.error} ${message}`, false);
  finishTranscriptTurn(state, turnId);
}

function stripAnsiSequences(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function visibleTextWidth(value: string): number {
  return Array.from(stripAnsiSequences(value)).length;
}

function renderInlineMarkdown(text: string, theme: ExtensionContext["ui"]["theme"]): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, (_match, value: string) => theme.bold(value))
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_match, value: string) => theme.italic(value));
}

function renderBtwTranscriptLines(text: string, theme: ExtensionContext["ui"]["theme"]): string[] {
  return text.length === 0 ? [""] : text.split(/\r?\n/).map((line) => renderInlineMarkdown(line, theme));
}

export function buildOverlayTranscript(
  entries: BtwTranscript,
  theme: ExtensionContext["ui"]["theme"],
  contentWidth = 80,
  options: Pick<BtwConfig, "showReasoning"> = { showReasoning: true },
  agentName?: string,
): string[] {
  if (entries.length === 0) {
    return [theme.fg("dim", "No BTW thread yet. Ask a side question to start one.")];
  }

  const lines: string[] = [];
  const userBadge = buildTranscriptBadge(theme, "You", "userMessageBg", "accent");
  const thinkingBadge = buildTranscriptBadge(theme, "Thinking", "toolPendingBg", "warning");
  const toolBadge = buildTranscriptBadge(theme, "Tool", "toolPendingBg", "warning");
  const assistantBadge = buildTranscriptBadge(theme, agentName ?? "Assistant", "customMessageBg", "success");
  const separator = theme.fg("borderMuted", "────────────────────────────────────────");
  const blockIndent = "    ";
  const resultIndent = blockIndent;
  const pushBlankLine = () => {
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
  };

  type BtwBlockRenderOptions = { blankBefore?: boolean; indent?: string; style?: (value: string) => string };
  const resolveBlockStyle = (opts: { style?: (value: string) => string }): ((value: string) => string) =>
    opts.style ?? ((value: string) => value);
  const maybeBlankLine = (blankBefore?: boolean): void => {
    if (blankBefore !== false) {
      pushBlankLine();
    }
  };
  const pushStyledLines = (bodyLines: string[], indent: string, style: (value: string) => string): void => {
    for (const line of bodyLines) {
      lines.push(`${indent}${style(line)}`);
    }
  };

  const pushInlineBlock = (
    header: string,
    text: string,
    options: BtwBlockRenderOptions = {},
  ) => {
    const bodyLines = text.split("\n");
    const style = resolveBlockStyle(options);
    maybeBlankLine(options.blankBefore);

    const firstLine = bodyLines.shift() ?? "";
    lines.push(`${header}${firstLine ? ` ${style(firstLine)}` : ""}`);
    pushStyledLines(bodyLines, blockIndent, style);
  };

  const pushStackedLines = (
    header: string,
    bodyLines: string[],
    options: BtwBlockRenderOptions = {},
  ) => {
    const indent = options.indent ?? blockIndent;
    const style = resolveBlockStyle(options);
    maybeBlankLine(options.blankBefore);

    lines.push(header);
    pushStyledLines(bodyLines, indent, style);
  };

  const pushStackedBlock = (
    header: string,
    text: string,
    options: BtwBlockRenderOptions = {},
  ) => {
    pushStackedLines(header, text.split("\n"), options);
  };

  const renderMarkdownBlockLines = (text: string, indent = blockIndent): string[] => {
    void Math.max(1, contentWidth - visibleTextWidth(indent));
    return renderBtwTranscriptLines(text, theme);
  };

  for (const entry of entries) {
    if (entry.type === "turn-boundary") {
      if (entry.phase === "start" && lines.length > 0) {
        pushBlankLine();
        lines.push(separator);
      }
      continue;
    }

    if (entry.type === "user-message") {
      pushInlineBlock(userBadge, entry.text, { blankBefore: false });
      continue;
    }

    if (entry.type === "thinking") {
      if (!options.showReasoning) {
        continue;
      }
      const thinkingHeader = entry.streaming ? `${thinkingBadge} ${theme.fg("warning", "▍")}` : thinkingBadge;
      pushStackedLines(thinkingHeader, renderMarkdownBlockLines(entry.text), {
        style: (line) => theme.fg("warning", theme.italic(line)),
      });
      continue;
    }

    if (entry.type === "tool-call") {
      if (!options.showReasoning) {
        continue;
      }
      const toolLabel = theme.fg("warning", theme.bold(entry.toolName));
      const argsLabel = entry.args ? theme.fg("dim", ` · ${entry.args}`) : "";
      pushInlineBlock(toolBadge, `${toolLabel}${argsLabel}`);
      continue;
    }

    if (entry.type === "tool-result") {
      if (!options.showReasoning) {
        continue;
      }
      const resultHeaderLabel = entry.isError
        ? theme.fg("error", "↳ error")
        : entry.streaming
          ? theme.fg("warning", "↳ streaming result")
          : theme.fg("dim", "↳ result");
      const truncationLabel = entry.truncated ? theme.fg("dim", " (truncated)") : "";
      pushStackedBlock(`${resultHeaderLabel}${truncationLabel}`, entry.content, {
        blankBefore: false,
        indent: resultIndent,
        style: (line) => (entry.isError ? theme.fg("error", line) : theme.fg("dim", line)),
      });
      continue;
    }

    if (entry.type === "assistant-text") {
      const assistantHeader = entry.streaming ? `${assistantBadge} ${theme.fg("warning", "▍")}` : assistantBadge;
      pushStackedLines(assistantHeader, renderMarkdownBlockLines(entry.text));
    }
  }

  return lines;
}

function getLastAssistantMessage(session: AgentSession): AssistantMessage | null {
  for (let i = session.state.messages.length - 1; i >= 0; i--) {
    const message = session.state.messages[i];
    if (message.role === "assistant") {
      return message as AssistantMessage;
    }
  }

  return null;
}

function normalizeBtwSessionAssistantUsages(session: AgentSession): void {
  for (const message of session.state.messages) {
    if (message.role === "assistant") {
      ensureBtwAssistantMessageUsage(message as AssistantMessage);
    }
  }
}

type BtwHandoffExchange = {
  user: string;
  assistant: string;
};

function buildBtwMessageContent(question: string, answer: string): string {
  return `Q: ${question}\n\nA: ${answer}`;
}

function formatThread(thread: BtwHandoffExchange[]): string {
  return thread.map((entry) => `User: ${entry.user.trim()}\nAssistant: ${entry.assistant.trim()}`).join("\n\n---\n\n");
}

function isThreadContinuationMarker(messages: Message[], index: number): boolean {
  const userMessage = messages[index];
  const assistantMessage = messages[index + 1];
  return (
    userMessage?.role === "user" &&
    extractMessageText(userMessage) === BTW_CONTINUE_THREAD_USER_TEXT &&
    assistantMessage?.role === "assistant" &&
    extractMessageText(assistantMessage) === BTW_CONTINUE_THREAD_ASSISTANT_TEXT
  );
}

function extractBtwHandoffThread(sessionRuntime: BtwSessionRuntime): BtwHandoffExchange[] {
  const handoffMessages = sessionRuntime.session.state.messages.slice(sessionRuntime.sideThreadStartIndex);
  const threadMessages = isThreadContinuationMarker(handoffMessages as Message[], 0) ? handoffMessages.slice(2) : handoffMessages;
  const exchanges: BtwHandoffExchange[] = [];
  let currentUser = "";
  let currentAssistant = "";

  const pushCurrent = () => {
    if (!currentUser && !currentAssistant) {
      return;
    }

    exchanges.push({
      user: currentUser.trim() || "(No user prompt)",
      assistant: currentAssistant.trim() || "(No assistant response)",
    });
    currentUser = "";
    currentAssistant = "";
  };

  for (const message of threadMessages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    const text = extractMessageText(message).trim();
    if (!text) {
      continue;
    }

    if (message.role === "user") {
      pushCurrent();
      currentUser = text;
      continue;
    }

    currentAssistant = currentAssistant ? `${currentAssistant}\n\n${text}` : text;
  }

  pushCurrent();
  return exchanges;
}

function saveVisibleBtwNote(
  pi: ExtensionAPI,
  details: BtwDetails,
  saveRequested: boolean,
  wasBusy: boolean,
): SaveState {
  if (!saveRequested) {
    return "not-saved";
  }

  const message = {
    customType: BTW_MESSAGE_TYPE,
    content: buildBtwMessageContent(details.question, details.answer),
    display: true,
    details,
  };

  if (wasBusy) {
    pi.sendMessage(message, { deliverAs: "followUp" });
    return "queued";
  }

  pi.sendMessage(message);
  return "saved";
}

function notify(ctx: ExtensionContext | ExtensionCommandContext | undefined, message: string, level: "info" | "warning" | "error"): void {
  if (ctx?.hasUI) {
    ctx.ui.notify(message, level);
  }
}

function buildTranscriptBadge(
  theme: ExtensionContext["ui"]["theme"],
  label: string,
  background: "userMessageBg" | "toolPendingBg" | "customMessageBg",
  foreground: "accent" | "warning" | "success",
): string {
  return theme.bg(background, theme.fg(foreground, theme.bold(` ${label} `)));
}

function buildBtwInjectContent(instructions: string, formattedThread: string): string {
  return instructions
    ? `Here is a side conversation I had. ${instructions}\n\n${formattedThread}`
    : `Here is a side conversation I had for additional context:\n\n${formattedThread}`;
}

export default function btwRuntimeCore(pi: ExtensionAPI) {
  let debugLogger: import("./debug-logger").BtwDebugLogger | null = null;
  function getBtwIcons(): BtwIconSet {
    return resolveBtwIcons().icons;
  }

  let configPromise: Promise<{ config: BtwConfig; diagnostics: string[] }> | null = null;
  let configDiagnosticsNotified = false;
  let pendingThread: BtwDetails[] = [];
  let pendingMode: BtwThreadMode = "contextual";
  let btwModelOverride: SessionModel | null = null;
  let btwThinkingOverride: SessionThinkingLevel | null = null;
  let selectedBtwAgentName: string | null = null;
  let selectedBtwAgent: BtwAgentDefinition | null = null;
  let transcriptState = createEmptyTranscriptState();
  let overlayStatus: string | null = null;
  let overlayDetails = "Agent: none · Model: none · Thinking: unknown";
  let overlayDraft = "";
  let overlayRuntime: OverlayRuntime | null = null;
  let lastUiContext: ExtensionContext | ExtensionCommandContext | null = null;
  let activeBtwSession: BtwSessionRuntime | null = null;

  function getThinkingColor(level: SessionThinkingLevel | "unknown"): string {
    switch (level) {
      case "off":
        return "thinkingOff";
      case "minimal":
        return "thinkingMinimal";
      case "low":
        return "thinkingLow";
      case "medium":
        return "thinkingMedium";
      case "high":
        return "thinkingHigh";
      case "xhigh":
        return "thinkingXhigh";
      default:
        return "dim";
    }
  }

  function hexToTruecolorAnsiFg(hex: string | undefined): string | undefined {
    if (!hex || !/^#[0-9A-Fa-f]{6}$/.test(hex)) {
      return undefined;
    }
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
      return undefined;
    }
    return `\x1b[38;2;${r};${g};${b}m`;
  }

  function buildOverlayDetails(ctx?: ExtensionContext | ExtensionCommandContext | null): string {
    const agentName = activeBtwSession?.agentName ?? selectedBtwAgentName ?? "none";
    const agent = selectedBtwAgent;
    const activeModel = activeBtwSession
      ? { label: activeBtwSession.modelKey, source: activeBtwSession.modelSource }
      : null;
    const model = btwModelOverride ?? getMainModel(ctx) ?? null;
    const agentModelLabel = agent?.model ? `${agent.model} (configured)` : null;
    let modelLabel = activeModel?.label ?? (btwModelOverride && model ? formatModelRef(model) : agentModelLabel ?? (model ? formatModelRef(model) : "none"));
    // Strip redundant API source labels and source parentheticals from modal metadata.
    modelLabel = modelLabel.replace(/\s+\([^)]+\)/g, "").trim();
    const thinkingLevel = activeBtwSession?.thinkingLevel ?? btwThinkingOverride ?? agent?.thinkingLevel ?? (pi.getThinkingLevel() as SessionThinkingLevel | undefined) ?? "unknown";
    const icons = getBtwIcons();
    const agentIcon = resolveBtwAgentIcon(agentName);
    const thinkingColor = getThinkingColor(thinkingLevel);
    const modelColorAnsi = hexToTruecolorAnsiFg(agent?.color);
    // Use the agent's frontmatter color for model metadata when available.
    // Fall back to the `accent` theme color when no explicit safe color is defined.
    const modelSegment = modelColorAnsi
      ? `${modelColorAnsi}${icons.model} ${modelLabel}\x1b[39m`
      : `<accent>${icons.model} ${modelLabel}</accent>`;
    return `${agentIcon} ${agentName} · ${icons.session} ${pendingMode} · ${modelSegment} · <${thinkingColor}>${icons.thinking} ${thinkingLevel}</${thinkingColor}>`;
  }

  function syncUi(ctx?: ExtensionContext | ExtensionCommandContext): void {
    const activeCtx = ctx ?? lastUiContext;
    overlayDetails = buildOverlayDetails(activeCtx);
    if (activeCtx?.hasUI) {
      activeCtx.ui.setWidget("btw", undefined);
      overlayRuntime?.refresh?.();
    }
  }

  function setOverlayStatus(status: string | null, ctx?: ExtensionContext | ExtensionCommandContext): void {
    overlayStatus = status;
    syncUi(ctx);
  }

  function formatPendingStatus(message: string): string {
    return `${getBtwIcons().pending} ${message}`;
  }

  function formatThinkingStatus(): string {
    return `${getBtwIcons().thinking} Thinking…`;
  }

  async function getBtwRuntimeConfig(ctx?: ExtensionContext | ExtensionCommandContext): Promise<BtwConfig> {
    configPromise ??= import("./config.js").then(({ loadBtwConfig }) => loadBtwConfig());
    const { config, diagnostics } = await configPromise;
    if (diagnostics.length > 0 && !configDiagnosticsNotified) {
      configDiagnosticsNotified = true;
      notify(ctx ?? lastUiContext ?? undefined, diagnostics.join("\n"), "warning");
    }
    return config;
  }

  function setOverlayDraft(value: string): void {
    overlayDraft = value;
    overlayRuntime?.setDraft?.(value);
  }

  function dismissOverlay(): void {
    overlayRuntime?.close?.();
    overlayRuntime = null;
  }

  function toggleOverlayFocus(): void {
    const handle = overlayRuntime?.handle;
    if (!handle) {
      return;
    }

    handle.setHidden(false);
    if (handle.isFocused()) {
      handle.unfocus();
    } else {
      handle.focus();
    }
    overlayRuntime?.refresh?.();
  }

  function focusOverlay(): void {
    const handle = overlayRuntime?.handle;
    if (!handle) {
      return;
    }

    handle.setHidden(false);
    handle.focus();
    overlayRuntime?.refresh?.();
  }

  function removeBtwSessionSubscription(sessionRuntime: BtwSessionRuntime, unsubscribe: () => void): void {
    if (!sessionRuntime.subscriptions.delete(unsubscribe)) {
      return;
    }

    try {
      unsubscribe();
    } catch (error) {
      void logDebugEvent("btw_unsubscribe_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function clearBtwSessionSubscriptions(sessionRuntime: BtwSessionRuntime): void {
    for (const unsubscribe of [...sessionRuntime.subscriptions]) {
      removeBtwSessionSubscription(sessionRuntime, unsubscribe);
    }
  }

  function handleBtwSessionEvent(
    sessionRuntime: BtwSessionRuntime,
    event: AgentSessionEvent,
    ctx?: ExtensionContext | ExtensionCommandContext,
  ): void {
    if (activeBtwSession?.session !== sessionRuntime.session || !overlayRuntime) {
      return;
    }

    applyTranscriptEvent(transcriptState, event);

    if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
      setOverlayStatus(formatThinkingStatus(), ctx);
    }

    if (event.type === "tool_execution_start") {
      setOverlayStatus(formatPendingStatus(`running tool: ${event.toolName}`), ctx);
      return;
    }

    if (event.type === "tool_execution_end") {
      setOverlayStatus(
        sessionRuntime.session.isStreaming
          ? formatPendingStatus(`running tool: ${event.toolName}`)
          : formatPendingStatus("streaming..."),
        ctx,
      );
      return;
    }

    if (event.type === "turn_end") {
      setOverlayStatus(formatPendingStatus("streaming..."), ctx);
      return;
    }

    if (
      event.type === "message_start" ||
      event.type === "message_update" ||
      event.type === "message_end" ||
      event.type === "turn_start"
    ) {
      syncUi(ctx);
    }
  }

  function subscribeOverlayToActiveBtwSession(ctx?: ExtensionContext | ExtensionCommandContext): void {
    const sessionRuntime = activeBtwSession;
    if (!sessionRuntime || sessionRuntime.subscriptions.size > 0) {
      return;
    }

    const unsubscribe = sessionRuntime.session.subscribe((event: AgentSessionEvent) => {
      handleBtwSessionEvent(sessionRuntime, event, ctx);
    });
    sessionRuntime.subscriptions.add(unsubscribe);
  }

  async function disposeBtwSession(): Promise<void> {
    const current = activeBtwSession;
    activeBtwSession = null;
    if (!current) {
      return;
    }

    clearBtwSessionSubscriptions(current);

    try {
      await current.session.abort();
    } catch (error) {
      await logDebugEvent("btw_abort_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    current.session.dispose();
  }

  async function dismissOverlaySession(): Promise<void> {
    dismissOverlay();
    await disposeBtwSession();
  }

  async function resolveBtwModel(
    ctx: ExtensionCommandContext,
    notifyOnFallback = false,
    agent?: BtwAgentDefinition | null,
  ): Promise<ResolvedBtwModel> {
    const mainModel = getMainModel(ctx);
    if (btwModelOverride) {
      const auth = await resolveModelRequestAuth(ctx.modelRegistry, btwModelOverride);
      if (auth.ok && auth.apiKey) {
        return {
          model: btwModelOverride,
          source: "override",
          configuredOverride: btwModelOverride,
        };
      }

      const fallbackReason = mainModel
        ? `Configured BTW model ${formatModelRef(btwModelOverride)} has no credentials. Falling back to main model ${formatModelRef(
            mainModel,
          )}.`
        : `Configured BTW model ${formatModelRef(btwModelOverride)} has no credentials, and no main model is active.`;
      if (notifyOnFallback) {
        notify(ctx, fallbackReason, "warning");
      }

      if (mainModel) {
        return {
          model: mainModel,
          source: "main",
          configuredOverride: btwModelOverride,
          fallbackReason,
        };
      }

      return {
        model: null,
        source: "none",
        configuredOverride: btwModelOverride,
        fallbackReason,
      };
    }

    if (agent?.model) {
      const agentModelReference = agent.model;
      const reportAgentModelFallback = (fallbackReason: string): ResolvedBtwModel => {
        if (notifyOnFallback) {
          notify(ctx, fallbackReason, "warning");
        }
        return {
          model: mainModel ?? null,
          source: mainModel ? "main" : "none",
          configuredOverride: null,
          agentModelReference,
          fallbackReason,
        };
      };
      const resolvedAgentModel = resolveModelReference(ctx, agentModelReference);
      if (resolvedAgentModel.model) {
        const auth = await resolveModelRequestAuth(ctx.modelRegistry, resolvedAgentModel.model);
        if (auth.ok && auth.apiKey) {
          return {
            model: resolvedAgentModel.model,
            source: "agent",
            configuredOverride: null,
            agentModelReference,
          };
        }

        const fallbackReason = mainModel
          ? `Agent '${agent.name}' model ${agentModelReference} has no credentials. Falling back to main model ${formatModelRef(mainModel)}.`
          : `Agent '${agent.name}' model ${agentModelReference} has no credentials, and no main model is active.`;
        return reportAgentModelFallback(fallbackReason);
      }

      const fallbackReason = mainModel
        ? `Agent '${agent.name}' model ${agentModelReference} was not found. Falling back to main model ${formatModelRef(mainModel)}.`
        : `Agent '${agent.name}' model ${agentModelReference} was not found, and no main model is active.`;
      return reportAgentModelFallback(fallbackReason);
    }

    if (mainModel) {
      return {
        model: mainModel,
        source: "main",
        configuredOverride: null,
      };
    }

    return {
      model: null,
      source: "none",
      configuredOverride: null,
    };
  }

  async function resolveBtwSettings(
    ctx: ExtensionCommandContext,
    notifyOnFallback = false,
    agent?: BtwAgentDefinition | null,
  ): Promise<ResolvedBtwSettings> {
    const resolvedModel = await resolveBtwModel(ctx, notifyOnFallback, agent);
    const sessionModel = resolvedModel.model ? prepareBtwSessionModel(resolvedModel.model) : null;
    const agentThinkingLevel = agent?.thinkingLevel as SessionThinkingLevel | undefined;
    const thinkingLevel = btwThinkingOverride ?? agentThinkingLevel ?? (pi.getThinkingLevel() as SessionThinkingLevel);

    return {
      model: sessionModel,
      modelSource: resolvedModel.source,
      configuredModelOverride: resolvedModel.configuredOverride,
      agentModelReference: resolvedModel.agentModelReference,
      thinkingLevel,
      thinkingSource: btwThinkingOverride ? "override" : agentThinkingLevel ? "agent" : "main",
      temperature: agent?.temperature,
      fallbackReason: resolvedModel.fallbackReason,
    };
  }

  function describeResolvedModel(settings: ResolvedBtwSettings): string {
    if (!settings.model) {
      if (settings.configuredModelOverride && settings.fallbackReason) {
        return `BTW model unavailable. ${settings.fallbackReason}`;
      }
      return "BTW model unavailable. No active model selected.";
    }

    const source =
      settings.modelSource === "override"
        ? "override"
        : settings.modelSource === "agent"
          ? `agent frontmatter${settings.agentModelReference ? ` (${settings.agentModelReference})` : ""}`
          : settings.configuredModelOverride || settings.agentModelReference
            ? "inherited fallback"
            : "inherits main thread";
    return `BTW model: ${formatModelRef(settings.model)} (${source}).${
      settings.fallbackReason ? ` ${settings.fallbackReason}` : ""
    }`;
  }

  function describeResolvedThinking(settings: ResolvedBtwSettings): string {
    const source =
      settings.thinkingSource === "override"
        ? "override"
        : settings.thinkingSource === "agent"
          ? "agent frontmatter"
          : "inherits main thread";
    return `BTW thinking: ${settings.thinkingLevel} (${source}).`;
  }

  async function setBtwModelOverride(ctx: ExtensionCommandContext, nextModel: SessionModel | null): Promise<void> {
    btwModelOverride = nextModel;
    const details: BtwModelOverrideDetails = nextModel
      ? { action: "set", timestamp: Date.now(), provider: nextModel.provider, id: nextModel.id, api: nextModel.api }
      : { action: "clear", timestamp: Date.now() };
    pi.appendEntry(BTW_MODEL_OVERRIDE_TYPE, details);
    await disposeBtwSession();
    const settings = await resolveBtwSettings(ctx, false, selectedBtwAgent);
    const message = nextModel
      ? `BTW model override set to ${formatModelRef(nextModel)}.`
      : "BTW model override cleared. BTW now uses the selected agent model when configured, otherwise the main thread model.";
    setOverlayStatus(message, ctx);
    notify(ctx, `${message} ${describeResolvedModel(settings)}`, "info");
  }

  async function setBtwThinkingOverride(
    ctx: ExtensionCommandContext,
    nextThinkingLevel: SessionThinkingLevel | null,
  ): Promise<void> {
    btwThinkingOverride = nextThinkingLevel;
    const details: BtwThinkingOverrideDetails = nextThinkingLevel
      ? { action: "set", timestamp: Date.now(), thinkingLevel: nextThinkingLevel }
      : { action: "clear", timestamp: Date.now() };
    pi.appendEntry(BTW_THINKING_OVERRIDE_TYPE, details);
    await disposeBtwSession();
    const settings = await resolveBtwSettings(ctx, false, selectedBtwAgent);
    const message = nextThinkingLevel
      ? `BTW thinking override set to ${nextThinkingLevel}.`
      : "BTW thinking override cleared. BTW now uses the selected agent thinking level when configured, otherwise the main thread thinking level.";
    setOverlayStatus(message, ctx);
    notify(ctx, `${message} ${describeResolvedThinking(settings)}`, "info");
  }

  async function resolveConfiguredBtwAgent(): Promise<BtwAgentDefinition | null> {
    if (selectedBtwAgent) {
      return selectedBtwAgent;
    }

    if (!selectedBtwAgentName) {
      return null;
    }

    const { findBtwAgentByName } = await import("./agent-discovery.js");
    selectedBtwAgent = await findBtwAgentByName(selectedBtwAgentName);
    if (!selectedBtwAgent) {
      selectedBtwAgentName = null;
    }

    return selectedBtwAgent;
  }

  async function persistSelectedBtwAgent(
    ctx: ExtensionContext | ExtensionCommandContext,
    agent: BtwAgentDefinition,
    notifyUser: boolean,
  ): Promise<void> {
    const previousAgentName = selectedBtwAgentName;
    selectedBtwAgent = agent;
    selectedBtwAgentName = agent.name;
    const details: BtwAgentSelectionDetails = { timestamp: Date.now(), name: agent.name };
    pi.appendEntry(BTW_AGENT_SELECTION_TYPE, details);

    if (previousAgentName && previousAgentName !== agent.name) {
      await disposeBtwSession();
    }

    const message = `BTW agent set to ${agent.name}.`;
    setOverlayStatus(message, ctx);
    if (notifyUser) {
      notify(ctx, `${message} ${agent.description}`, "info");
    }
  }

  async function selectBtwAgent(
    ctx: ExtensionCommandContext,
    options: { forcePicker?: boolean; notifyUser?: boolean } = {},
  ): Promise<BtwAgentDefinition | null> {
    const { discoverBtwAgents } = await import("./agent-discovery.js");
    const agents = await discoverBtwAgents();
    if (agents.length === 0) {
      const message = "No agent markdown files were found for BTW selection.";
      setOverlayStatus(message, ctx);
      notify(ctx, message, "error");
      return null;
    }

    const configuredAgent = await resolveConfiguredBtwAgent();
    if (configuredAgent && !options.forcePicker) {
      return configuredAgent;
    }

    if (ctx.hasUI) {
      const { buildBtwAgentSelectionMenu } = await import("./agent-selection-ui.js");
      const menu = buildBtwAgentSelectionMenu(agents, selectedBtwAgentName);
      const selectedLabel = await ctx.ui.select(
        `Select BTW agent (current: ${selectedBtwAgentName || "none"}; ↑/↓, Enter, Esc: cancel)`,
        menu.labels,
      );

      if (!selectedLabel) {
        setOverlayStatus("BTW agent selection canceled.", ctx);
        return null;
      }

      const selectedAgentName = menu.valueByLabel.get(selectedLabel);
      if (!selectedAgentName) {
        const message = "Unknown BTW agent selection. Please try again.";
        setOverlayStatus(message, ctx);
        notify(ctx, message, "warning");
        return null;
      }

      const selectedAgent = agents.find((agent) => agent.name === selectedAgentName);
      if (!selectedAgent) {
        const message = `Selected BTW agent ${selectedAgentName} is no longer available.`;
        setOverlayStatus(message, ctx);
        notify(ctx, message, "error");
        return null;
      }

      await persistSelectedBtwAgent(ctx, selectedAgent, options.notifyUser ?? true);
      return selectedAgent;
    }

    const defaultAgent = agents.find((agent) => agent.name === DEFAULT_BTW_AGENT_NAME) ?? agents[0];
    await persistSelectedBtwAgent(ctx, defaultAgent, options.notifyUser ?? false);
    return defaultAgent;
  }

  async function createBtwSubSession(
    ctx: ExtensionCommandContext,
    mode: BtwThreadMode,
    agent: BtwAgentDefinition,
    settings: ResolvedBtwSettings,
  ): Promise<BtwSessionRuntime> {
    if (!settings.model) {
      throw new Error(settings.fallbackReason || "No active model selected.");
    }

    const { messages: seedMessages, sideThreadStartIndex } = await buildBtwSeedState(ctx, pendingThread, mode, settings.model);
    const resourceLoader = await createBtwResourceLoader(ctx, [sanitizeBtwAgentSystemPrompt(agent.systemPrompt)], createBtwSessionExtensions(settings));

    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      model: settings.model,
      modelRegistry: adaptModelRegistryForAgentSession(ctx.modelRegistry) as AgentSession["modelRegistry"],
      thinkingLevel: settings.thinkingLevel,
      // BTW side sessions intentionally run without tools or resource collections.
      noTools: "all",
      tools: [],
      resourceLoader,
    });
    await disableSessionTools(session);

    if (seedMessages.length > 0) {
      session.agent.state.messages = seedMessages as typeof session.state.messages;
    }

    return {
      session,
      mode,
      agentName: agent.name,
      modelKey: formatModelRef(settings.model),
      modelSource: settings.modelSource,
      thinkingLevel: settings.thinkingLevel,
      thinkingSource: settings.thinkingSource,
      subscriptions: new Set(),
      sideThreadStartIndex,
    };
  }

  async function ensureBtwSession(
    ctx: ExtensionCommandContext,
    mode: BtwThreadMode,
    preselectedAgent?: BtwAgentDefinition,
    preResolvedSettings?: ResolvedBtwSettings,
  ): Promise<BtwSessionRuntime | null> {
    const agent = preselectedAgent ?? (await selectBtwAgent(ctx, { notifyUser: !selectedBtwAgentName }));
    if (!agent) {
      return null;
    }

    const settings = preResolvedSettings ?? (await resolveBtwSettings(ctx, false, agent));
    if (!settings.model) {
      return null;
    }

    const modelKey = formatModelRef(settings.model);
    if (
      activeBtwSession?.mode === mode &&
      activeBtwSession.agentName === agent.name &&
      activeBtwSession.modelKey === modelKey &&
      activeBtwSession.thinkingLevel === settings.thinkingLevel
    ) {
      return activeBtwSession;
    }

    await disposeBtwSession();
    activeBtwSession = await createBtwSubSession(ctx, mode, agent, settings);
    return activeBtwSession;
  }

  async function ensureOverlay(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
    if (!ctx.hasUI) {
      return;
    }
    lastUiContext = ctx;
    overlayDetails = buildOverlayDetails(ctx);

    if (overlayRuntime?.handle) {
      subscribeOverlayToActiveBtwSession(ctx);
      focusOverlay();
      return;
    }

    const runtimeConfig = await getBtwRuntimeConfig(ctx);
    let overlayTui: TUI | undefined;
    const overlayOptions = () => resolveBtwModalDimensions(overlayTui, runtimeConfig.modalSize);
    const runtime: OverlayRuntime = {};
    const closeRuntime = () => {
      if (runtime.closed) {
        return;
      }
      runtime.closed = true;
      if (activeBtwSession) {
        clearBtwSessionSubscriptions(activeBtwSession);
      }
      runtime.handle?.hide();
      if (overlayRuntime === runtime) {
        overlayRuntime = null;
      }
      runtime.finish?.();
    };

    runtime.close = closeRuntime;
    overlayRuntime = runtime;

    const { BtwOverlayComponent } = await import("./btw-overlay.js");

    void ctx.ui
      .custom<void>(
        async (tui, theme, keybindings, done) => {
          overlayTui = tui;
          runtime.finish = () => {
            done();
          };

          const overlay = new BtwOverlayComponent({
            tui,
            theme,
            keybindings,
            readTranscriptEntries: () => transcriptState.entries,
            getStatus: () => overlayStatus,
            getMode: () => pendingMode,
            getDetails: () => overlayDetails,
            config: runtimeConfig,
            renderTranscript: (entries, theme, width, options) =>
              buildOverlayTranscript(entries, theme, width, options, activeBtwSession?.agentName ?? selectedBtwAgentName ?? "Assistant"),
            resolveModalDimensions: resolveBtwModalDimensions,
            onSubmit: (value) => {
              void submitFromOverlay(ctx, value);
            },
            onDismiss: () => {
              void dismissOverlaySession();
            },
            onUnfocus: () => {
              overlayRuntime?.handle?.unfocus();
              overlayRuntime?.refresh?.();
            },
            onInjectSelect: (selectedIndices, instructions) => {
              void handleInjectSelect(ctx as ExtensionCommandContext, selectedIndices, instructions);
            },
          });

          overlay.focused = runtime.handle?.isFocused() ?? true;
          overlay.setDraft(overlayDraft);
          runtime.setDraft = (value) => {
            overlay.setDraft(value);
          };
          runtime.refresh = () => {
            overlay.focused = runtime.handle?.isFocused() ?? false;
            overlay.refresh();
          };
          runtime.close = () => {
            overlayDraft = overlay.getDraft();
            overlay.dispose();
            closeRuntime();
          };
          runtime.enterInjectSelect = (instructions: string) => {
            overlay.enterInjectSelectMode(instructions);
          };
          runtime.exitInjectSelect = () => {
            overlay.exitInjectSelectMode();
          };

          subscribeOverlayToActiveBtwSession(ctx);

          if (runtime.closed) {
            done();
          }

          return overlay;
        },
        {
          overlay: true,
          overlayOptions,
          onHandle: (handle) => {
            runtime.handle = handle;
            handle.focus();
            if (runtime.closed) {
              closeRuntime();
            }
          },
        },
      )
      .catch((error) => {
        if (overlayRuntime === runtime) {
          overlayRuntime = null;
        }
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      });
  }

  async function logDebugEvent(
    event: string,
    details: Record<string, unknown>,
    ctx?: ExtensionContext | ExtensionCommandContext,
  ): Promise<void> {
    try {
      debugLogger ??= (await import("./debug-logger.js")).createBtwDebugLogger();
      await debugLogger.log(event, details);
    } catch (error) {
      if (ctx) {
        const message = error instanceof Error ? error.message : String(error);
        notify(ctx, `BTW debug logging failed: ${message}`, "warning");
      }
    }
  }

  async function dispatchBtwCommand(name: string, args: string, ctx: ExtensionCommandContext): Promise<boolean> {
    const trimmedArgs = args.trim();
    await logDebugEvent("command", { name, hasArgs: trimmedArgs.length > 0 }, ctx);

    const openBtwOverlay = async (mode: BtwThreadMode): Promise<true> => {
      const sessionRuntime = await ensureBtwSession(ctx, mode);
      if (sessionRuntime && overlayStatus?.startsWith("BTW agent set to ")) {
        setOverlayStatus(null, ctx);
      }
      await ensureOverlay(ctx);
      return true;
    };
    const reportBtwAgentList = async (agents: readonly BtwAgentDefinition[]): Promise<true> => {
      const { buildBtwAgentListSummary } = await import("./agent-selection-ui.js");
      notify(ctx, buildBtwAgentListSummary(agents, selectedBtwAgentName), "info");
      return true;
    };

    if (name === "btw") {
      const { question, save } = parseBtwArgs(trimmedArgs);
      if (!question) {
        return openBtwOverlay(pendingMode);
      }

      if (pendingMode !== "contextual") {
        await resetThread(ctx, true, "contextual");
      }

      await runBtw(ctx, question, save, "contextual");
      return true;
    }

    if (name === "btw:tangent") {
      const { question, save } = parseBtwArgs(trimmedArgs);
      if (pendingMode !== "tangent") {
        await resetThread(ctx, true, "tangent");
      }

      if (!question) {
        return openBtwOverlay("tangent");
      }

      await runBtw(ctx, question, save, "tangent");
      return true;
    }

    if (name === "btw:new") {
      await resetThread(ctx, true, "contextual");
      const { question, save } = parseBtwArgs(trimmedArgs);
      if (question) {
        await runBtw(ctx, question, save, "contextual");
      } else {
        await ensureBtwSession(ctx, "contextual");
        setOverlayStatus("Started a fresh BTW thread.", ctx);
        await ensureOverlay(ctx);
        notify(ctx, "Started a fresh BTW thread.", "info");
      }
      return true;
    }

    if (name === "btw:clear") {
      await resetThread(ctx);
      dismissOverlay();
      notify(ctx, "Cleared BTW thread.", "info");
      return true;
    }

    if (name === "btw:agent") {
      const { discoverBtwAgents } = await import("./agent-discovery.js");
      const agents = await discoverBtwAgents();
      if (!trimmedArgs && !ctx.hasUI) {
        return reportBtwAgentList(agents);
      }

      if (!trimmedArgs && ctx.hasUI) {
        await selectBtwAgent(ctx, { forcePicker: true, notifyUser: true });
        return true;
      }

      if (trimmedArgs === "list") {
        return reportBtwAgentList(agents);
      }

      const selectedAgent = agents.find((agent) => agent.name === trimmedArgs);
      if (!selectedAgent) {
        const { buildBtwAgentListSummary } = await import("./agent-selection-ui.js");
        const message = `Unknown BTW agent: ${trimmedArgs}\n${buildBtwAgentListSummary(agents, selectedBtwAgentName)}`;
        setOverlayStatus(message, ctx);
        notify(ctx, message, "error");
        return true;
      }

      await persistSelectedBtwAgent(ctx, selectedAgent, true);
      return true;
    }

    if (name === "btw:model") {
      const parsed = parseBtwModelArgs(trimmedArgs);
      if (parsed.action === "invalid") {
        setOverlayStatus(parsed.message, ctx);
        notify(ctx, parsed.message, "error");
        return true;
      }

      if (parsed.action === "show") {
        const settings = await resolveBtwSettings(ctx, false, await resolveConfiguredBtwAgent());
        const message = describeResolvedModel(settings);
        setOverlayStatus(message, ctx);
        notify(ctx, message, settings.model ? "info" : "warning");
        return true;
      }

      if (parsed.action === "clear") {
        await setBtwModelOverride(ctx, null);
        return true;
      }
      const ref = parsed.model;
      const resolved = ctx.modelRegistry.find(ref.provider, ref.id);
      if (!resolved) {
        const message = `Unknown model ${ref.provider}/${ref.id}. Use /login or /models to add it before setting it as the BTW override.`;
        setOverlayStatus(message, ctx);
        notify(ctx, message, "error");
        return true;
      }
      await setBtwModelOverride(ctx, resolved);
      return true;
    }

    if (name === "btw:thinking") {
      const parsed = parseBtwThinkingArgs(trimmedArgs);
      if (parsed.action === "show") {
        const settings = await resolveBtwSettings(ctx, false, await resolveConfiguredBtwAgent());
        const message = describeResolvedThinking(settings);
        setOverlayStatus(message, ctx);
        notify(ctx, message, "info");
        return true;
      }

      await setBtwThinkingOverride(ctx, parsed.action === "clear" ? null : parsed.thinkingLevel);
      return true;
    }

    if (name === "btw:inject-select") {
      if (pendingThread.length === 0) {
        notify(ctx, "No BTW thread to inject.", "warning");
        return true;
      }

      if (!overlayRuntime && ctx.hasUI) {
        setOverlayStatus(formatPendingStatus("selecting turns to inject..."), ctx);
        const exchanges = getPendingThreadForHandoff();
        const labels = exchanges.map((ex, i) => `${i + 1}. ${ex.user.split("\n")[0]}`);
        const selectedLabel = await ctx.ui.select("Select BTW exchange to inject", labels);
        if (!selectedLabel) {
          setOverlayStatus("BTW exchange selection canceled.", ctx);
          return true;
        }
        const selectedIndex = labels.indexOf(selectedLabel);
        if (selectedIndex === -1 || !exchanges[selectedIndex]) {
          setOverlayStatus("Unknown BTW exchange selection.", ctx);
          return true;
        }
        const selected = [exchanges[selectedIndex]];
        const content = buildBtwInjectContent(trimmedArgs, formatThread(selected));
        await deliverBtwThread(ctx, content, selected.length, "Injected selected BTW thread");
        return true;
      }

      setOverlayStatus(formatPendingStatus("selecting turns to inject..."), ctx);
      await ensureOverlay(ctx);
      overlayRuntime?.enterInjectSelect?.(trimmedArgs);
      return true;
    }

    if (name === "btw:inject") {
      if (pendingThread.length === 0) {
        notify(ctx, "No BTW thread to inject.", "warning");
        return true;
      }

      setOverlayStatus(formatPendingStatus("injecting into the main session..."), ctx);
      await ensureOverlay(ctx);

      try {
        const { thread } = await getBtwHandoffThread(ctx);
        const instructions = trimmedArgs;
        const content = buildBtwInjectContent(instructions, formatThread(thread));
        await deliverBtwThread(ctx, content, thread.length, "Injected BTW thread");
      } catch (error) {
        setOverlayStatus("Inject failed. Thread preserved for retry or summarize.", ctx);
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      }
      return true;
    }

    if (name === "btw:summarize") {
      if (pendingThread.length === 0) {
        notify(ctx, "No BTW thread to summarize.", "warning");
        return true;
      }

      setOverlayStatus(formatPendingStatus("summarizing..."), ctx);
      await ensureOverlay(ctx);

      try {
        const { thread } = await getBtwHandoffThread(ctx);
        const summary = await summarizeThread(ctx, thread);
        const instructions = trimmedArgs;
        const content = instructions
          ? `Here is a summary of a side conversation I had. ${instructions}\n\n${summary}`
          : `Here is a summary of a side conversation I had:\n\n${summary}`;

        await deliverBtwThread(ctx, content, thread.length, "Injected BTW summary");
      } catch (error) {
        setOverlayStatus("Summarize failed. Thread preserved for retry or injection.", ctx);
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      }
      return true;
    }

    return false;
  }

  function parseOverlayBtwCommand(value: string): { name: string; args: string } | null {
    return parseAsideSlashCommand(value);
  }

  async function submitFromOverlay(ctx: ExtensionCommandContext | ExtensionContext, value: string): Promise<void> {
    const question = value.trim();
    if (!question) {
      setOverlayStatus("Enter a BTW prompt before submitting.", ctx);
      return;
    }

    if (!("getSystemPrompt" in ctx)) {
      setOverlayStatus("BTW overlay submit requires a command context. Reopen BTW from a command.", ctx);
      return;
    }

    const cmdCtx = ctx as ExtensionCommandContext;
    const btwCommand = parseOverlayBtwCommand(question);
    if (btwCommand) {
      setOverlayDraft("");
      await dispatchBtwCommand(btwCommand.name, btwCommand.args, cmdCtx);
      return;
    }

    setOverlayDraft("");
    setOverlayStatus(formatPendingStatus("streaming..."), ctx);
    syncUi(ctx);
    await runBtw(cmdCtx, question, false, pendingMode);
  }

  async function resetThread(
    ctx: ExtensionContext | ExtensionCommandContext,
    persist = true,
    mode: BtwThreadMode = "contextual",
  ): Promise<void> {
    await disposeBtwSession();
    pendingThread = [];
    pendingMode = mode;
    transcriptState = createEmptyTranscriptState();
    setOverlayDraft("");
    setOverlayStatus(null, ctx);
    if (persist) {
      const details: BtwResetDetails = { timestamp: Date.now(), mode };
      pi.appendEntry(BTW_RESET_TYPE, details);
    }
    syncUi(ctx);
  }

  async function restoreThread(ctx: ExtensionContext): Promise<void> {
    await disposeBtwSession();
    pendingThread = [];
    pendingMode = "contextual";
    btwModelOverride = null;
    btwThinkingOverride = null;
    selectedBtwAgentName = null;
    selectedBtwAgent = null;
    transcriptState = createEmptyTranscriptState();
    overlayDraft = "";
    lastUiContext = ctx;
    overlayStatus = null;

    const branch = ctx.sessionManager.getBranch();
    let lastResetIndex = -1;
    let restoredAgentName: string | null = null;

    for (let i = 0; i < branch.length; i++) {
      if (isCustomEntry(branch[i], BTW_MODEL_OVERRIDE_TYPE)) {
        const details = (branch[i] as unknown as { data?: BtwModelOverrideDetails }).data;
        if (details?.action === "set") {
          const resolved = ctx.modelRegistry.find(details.provider, details.id);
          if (resolved) {
            btwModelOverride = resolved;
          } else {
            // Configured override is no longer in the registry; drop it on restore.
            btwModelOverride = null;
          }
        } else if (details?.action === "clear") {
          btwModelOverride = null;
        }
      }

      if (isCustomEntry(branch[i], BTW_THINKING_OVERRIDE_TYPE)) {
        const details = (branch[i] as unknown as { data?: BtwThinkingOverrideDetails }).data;
        btwThinkingOverride =
          details?.action === "set"
            ? details.thinkingLevel
            : details?.action === "clear"
              ? null
              : btwThinkingOverride;
      }

      if (isCustomEntry(branch[i], BTW_AGENT_SELECTION_TYPE)) {
        const details = (branch[i] as unknown as { data?: BtwAgentSelectionDetails }).data;
        restoredAgentName = typeof details?.name === "string" ? details.name : restoredAgentName;
      }

      if (isCustomEntry(branch[i], BTW_RESET_TYPE)) {
        lastResetIndex = i;
        const details = (branch[i] as unknown as { data?: BtwResetDetails }).data;
        pendingMode = details?.mode ?? "contextual";
      }
    }

    if (restoredAgentName) {
      selectedBtwAgentName = restoredAgentName;
      const { findBtwAgentByName } = await import("./agent-discovery.js");
      selectedBtwAgent = await findBtwAgentByName(restoredAgentName);
      if (!selectedBtwAgent) {
        selectedBtwAgentName = null;
      }
    }

    for (const entry of branch.slice(lastResetIndex + 1)) {
      if (!isCustomEntry(entry, BTW_ENTRY_TYPE)) {
        continue;
      }

      const details = (entry as unknown as { data?: BtwDetails }).data;
      if (!details?.question || !details.answer) {
        continue;
      }

      const normalizedDetails: BtwDetails = {
        ...details,
        api: details.api || getMainModel(ctx)?.api || "openai-responses",
      };

      pendingThread.push(normalizedDetails);
      appendPersistedTranscriptTurn(transcriptState, normalizedDetails);
    }

    syncUi(ctx);
  }

  async function runBtw(
    ctx: ExtensionCommandContext,
    question: string,
    saveRequested: boolean,
    mode: BtwThreadMode,
  ): Promise<void> {
    lastUiContext = ctx;
    const agent = await selectBtwAgent(ctx, { notifyUser: !selectedBtwAgentName });
    if (!agent) {
      const message = overlayStatus || "No BTW agent selected.";
      setOverlayStatus(message, ctx);
      notify(ctx, message, "warning");
      return;
    }

    const settings = await resolveBtwSettings(ctx, true, agent);
    const model = settings.model;
    if (!model) {
      const message = settings.fallbackReason || "No active model selected.";
      setOverlayStatus(message, ctx);
      notify(ctx, message, "error");
      return;
    }

    const auth = await resolveModelRequestAuth(ctx.modelRegistry, model);
    if (!auth.ok || !auth.apiKey) {
      const message = auth.ok ? `No credentials available for ${model.provider}/${model.id}.` : auth.error;
      setOverlayStatus(message, ctx);
      notify(ctx, message, "error");
      await ensureOverlay(ctx);
      return;
    }

    const sessionRuntime = await ensureBtwSession(ctx, mode, agent, settings);
    if (!sessionRuntime) {
      const message = overlayStatus || "No BTW agent selected.";
      setOverlayStatus(message, ctx);
      notify(ctx, message, "warning");
      return;
    }

    const session = sessionRuntime.session;
    const wasBusy = !ctx.isIdle();
    pendingMode = mode;
    const thinkingLevel = settings.thinkingLevel;

    setOverlayStatus(formatPendingStatus("streaming..."), ctx);
    await ensureOverlay(ctx);

    normalizeBtwSessionAssistantUsages(session);
    try {
      await session.prompt(question, { source: "extension" });

      const response = getLastAssistantMessage(session);
      if (!response) {
        throw new Error("BTW request finished without a response.");
      }
      ensureBtwAssistantMessageUsage(response);
      if (response.stopReason === "aborted") {
        removeTranscriptTurn(transcriptState, transcriptState.lastTurnId ?? transcriptState.currentTurnId);
        setOverlayStatus("Request aborted.", ctx);
        return;
      }
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "BTW request failed.");
      }

      const completedTurnId = transcriptState.lastTurnId ?? transcriptState.currentTurnId;
      const streamedThinking =
        completedTurnId !== null ? findLatestTranscriptEntry(transcriptState, completedTurnId, "thinking")?.text : "";
      const answer = extractAnswer(response);
      const thinking = extractThinking(response) || streamedThinking || "";

      const details: BtwDetails = {
        question,
        thinking,
        answer,
        provider: model.provider,
        model: model.id,
        api: model.api,
        thinkingLevel,
        timestamp: Date.now(),
        usage: response.usage,
      };

      pendingThread.push(details);
      pi.appendEntry(BTW_ENTRY_TYPE, details);

      const saveState = saveVisibleBtwNote(pi, details, saveRequested, wasBusy);
      if (saveState === "saved") {
        notify(ctx, "Saved BTW note to the session.", "info");
        setOverlayStatus("Saved BTW note to the session.", ctx);
      } else if (saveState === "queued") {
        notify(ctx, "BTW note queued to save after the current turn finishes.", "info");
        setOverlayStatus("BTW note queued to save after the current turn finishes.", ctx);
      } else {
        setOverlayStatus("Ready for a follow-up. Hidden BTW thread updated.", ctx);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setTranscriptFailure(transcriptState, errorMessage, getBtwIcons());
      setOverlayStatus("Request failed. Thread preserved for retry or follow-up.", ctx);
      notify(ctx, errorMessage, "error");
      await disposeBtwSession();
    } finally {
      syncUi(ctx);
    }
  }

  function getPendingThreadForHandoff(): BtwHandoffExchange[] {
    return pendingThread.map((entry) => ({ user: entry.question, assistant: entry.answer }));
  }

  async function handleInjectSelect(
    ctx: ExtensionCommandContext,
    selectedIndices: number[],
    instructions: string,
  ): Promise<void> {
    const exchanges = getPendingThreadForHandoff();
    const selected = selectedIndices.map((i) => exchanges[i]).filter(Boolean);
    if (selected.length === 0) {
      notify(ctx, "No exchanges selected to inject.", "warning");
      overlayRuntime?.exitInjectSelect?.();
      return;
    }

    setOverlayStatus(formatPendingStatus("injecting selected turns into the main session..."), ctx);
    await ensureOverlay(ctx);

    const content = buildBtwInjectContent(instructions, formatThread(selected));
    await deliverBtwThread(ctx, content, selected.length, "Injected selected BTW thread");
  }

  async function getBtwHandoffThread(
    ctx: ExtensionCommandContext,
  ): Promise<{ sessionRuntime: BtwSessionRuntime | null; thread: BtwHandoffExchange[] }> {
    const sessionRuntime = activeBtwSession ?? (await ensureBtwSession(ctx, pendingMode));
    const thread = sessionRuntime ? extractBtwHandoffThread(sessionRuntime) : [];
    const resolvedThread = thread.length > 0 ? thread : getPendingThreadForHandoff();

    if (resolvedThread.length === 0) {
      throw new Error("No BTW thread available for handoff.");
    }

    return { sessionRuntime, thread: resolvedThread };
  }

  async function summarizeThread(ctx: ExtensionCommandContext, thread: BtwHandoffExchange[]): Promise<string> {
    const agent = await selectBtwAgent(ctx, { notifyUser: false });
    if (!agent) {
      throw new Error("No BTW agent selected for summarization.");
    }

    const settings = await resolveBtwSettings(ctx, true, agent);
    const model = settings.model;
    if (!model) {
      throw new Error(settings.fallbackReason || "No active model selected.");
    }

    const auth = await resolveModelRequestAuth(ctx.modelRegistry, model);
    if (!auth.ok || !auth.apiKey) {
      throw new Error(auth.ok ? `No credentials available for ${model.provider}/${model.id}.` : auth.error);
    }

    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      model,
      modelRegistry: adaptModelRegistryForAgentSession(ctx.modelRegistry) as AgentSession["modelRegistry"],
      thinkingLevel: "off",
      noTools: "all",
      tools: [],
      resourceLoader: await createBtwResourceLoader(
        ctx,
        [sanitizeBtwAgentSystemPrompt(agent.systemPrompt), BTW_SUMMARIZE_SYSTEM_PROMPT],
        createBtwSessionExtensions(settings),
      ),
    });
    await disableSessionTools(session);

    try {
      await session.prompt(formatThread(thread), { source: "extension" });

      const response = getLastAssistantMessage(session);
      if (!response) {
        throw new Error("BTW summarize finished without a response.");
      }
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "Failed to summarize BTW thread.");
      }
      if (response.stopReason === "aborted") {
        throw new Error("BTW summarize aborted.");
      }

      return extractAnswer(response);
    } finally {
      try {
        await session.abort();
      } catch (error) {
        await logDebugEvent("btw_summarize_abort_error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      session.dispose();
    }
  }

  function sendThreadToMain(ctx: ExtensionCommandContext, content: string): void {
    if (ctx.isIdle()) {
      pi.sendUserMessage(content);
    } else {
      pi.sendUserMessage(content, { deliverAs: "followUp" });
    }
  }

  async function deliverBtwThread(
    ctx: ExtensionCommandContext,
    content: string,
    count: number,
    label: string,
  ): Promise<void> {
    sendThreadToMain(ctx, content);
    await resetThread(ctx);
    dismissOverlay();
    notify(ctx, `${label} (${count} exchange${count === 1 ? "" : "s"}).`, "info");
  }

  pi.on("session_start", async (_event, ctx) => {
    await restoreThread(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await restoreThread(ctx);
  });

  pi.on("session_shutdown", async () => {
    await disposeBtwSession();
    dismissOverlay();
  });

  for (const shortcut of BTW_FOCUS_SHORTCUTS) {
    pi.registerShortcut(shortcut, {
      description: "Toggle BTW overlay focus while leaving it open.",
      handler: async (_ctx) => {
        toggleOverlayFocus();
      },
    });
  }

  pi.registerCommand(ASIDE_COMMAND_NAME, {
    description: ASIDE_COMMAND_DESCRIPTION,
    handler: async (args, ctx) => {
      const command = parseAsideCommandArgs(args);
      await dispatchBtwCommand(command.name, command.args, ctx);
    },
  });
}
