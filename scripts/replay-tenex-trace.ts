import {
  CONTEXT_MANAGEMENT_KEY,
  ScratchpadStrategy,
  createContextManagementRuntime,
  type ContextManagementTelemetryEvent,
  type ScratchpadConversationEntry,
  type ScratchpadState,
  type ScratchpadStore,
  type ScratchpadStoreKey,
} from "../src/index.ts";
import type { LanguageModelV3Message, LanguageModelV3Prompt } from "@ai-sdk/provider";

type JaegerTag = {
  key: string;
  value: unknown;
};

type JaegerLogField = {
  key: string;
  value: unknown;
};

type JaegerLog = {
  fields?: JaegerLogField[];
};

type JaegerSpan = {
  spanID: string;
  operationName: string;
  startTime: number;
  tags?: JaegerTag[];
  logs?: JaegerLog[];
};

type TraceResponse = {
  data?: Array<{
    spans?: JaegerSpan[];
  }>;
};

type AiPromptMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
};

class InMemoryScratchpadStore implements ScratchpadStore {
  private readonly values = new Map<string, ScratchpadState>();

  private key(key: ScratchpadStoreKey): string {
    return `${key.conversationId}:${key.agentId}`;
  }

  async get(key: ScratchpadStoreKey): Promise<ScratchpadState | undefined> {
    const value = this.values.get(this.key(key));
    if (!value) {
      return undefined;
    }

    return {
      ...value,
      ...(value.entries ? { entries: { ...value.entries } } : {}),
      omitToolCallIds: [...value.omitToolCallIds],
    };
  }

  async set(key: ScratchpadStoreKey, state: ScratchpadState): Promise<void> {
    this.values.set(this.key(key), {
      ...state,
      ...(state.entries ? { entries: { ...state.entries } } : {}),
      omitToolCallIds: [...state.omitToolCallIds],
    });
  }

  async listConversation(conversationId: string): Promise<ScratchpadConversationEntry[]> {
    const entries: ScratchpadConversationEntry[] = [];

    for (const [key, state] of this.values.entries()) {
      const [entryConversationId, agentId] = key.split(":");
      if (entryConversationId !== conversationId) {
        continue;
      }

      entries.push({
        agentId,
        agentLabel: state.agentLabel,
        state: {
          ...state,
          ...(state.entries ? { entries: { ...state.entries } } : {}),
          omitToolCallIds: [...state.omitToolCallIds],
        },
      });
    }

    return entries;
  }
}

const DEFAULTS = {
  jaegerUrl: "http://localhost:16686",
  traceId: "5e8d35a7af9600000000000000000000",
  aiSpanId: "",
  targetText: "which model are you using now?",
  conversationId: "tg_599309204_6",
  agentId: "697fecfef6c65dab65894889d422cdd0158bdc31450c78357d13d7107ab3a719",
  agentLabel: "Transparent",
};

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function getTag(span: JaegerSpan, key: string): unknown {
  return span.tags?.find((tag) => tag.key === key)?.value;
}

function getLogFieldValues(span: JaegerSpan, key: string): unknown[] {
  return (span.logs ?? []).flatMap((log) =>
    (log.fields ?? [])
      .filter((field) => field.key === key)
      .map((field) => field.value)
  );
}

function parseJson<T>(value: unknown, label: string): T {
  if (typeof value !== "string") {
    throw new Error(`${label} was not a JSON string`);
  }

  return JSON.parse(value) as T;
}

function summarizeContent(message: LanguageModelV3Message): string {
  if (typeof message.content === "string") {
    return message.content.replace(/\s+/g, " ").slice(0, 120);
  }

  if (!Array.isArray(message.content)) {
    return "[non-array content]";
  }

  const summary = message.content.map((part) => {
    if (part.type === "text") {
      return part.text.replace(/\s+/g, " ").slice(0, 80);
    }
    if (part.type === "tool-call") {
      return `[tool-call:${part.toolName}:${part.toolCallId}]`;
    }
    if (part.type === "tool-result") {
      return `[tool-result:${part.toolName}:${part.toolCallId}]`;
    }
    return `[${part.type}]`;
  }).join(" ");

  return summary.slice(0, 120);
}

function toPromptMessage(message: AiPromptMessage): LanguageModelV3Message {
  if (typeof message.content === "string") {
    return {
      role: message.role,
      content: [{ type: "text", text: message.content }],
    };
  }

  if (Array.isArray(message.content)) {
    return {
      role: message.role,
      content: message.content as LanguageModelV3Message["content"],
    };
  }

  throw new Error(`Unsupported message content for role ${message.role}`);
}

function nonSystemCount(prompt: LanguageModelV3Prompt): number {
  return prompt.reduce((count, message) => count + (message.role === "system" ? 0 : 1), 0);
}

function containsText(prompt: LanguageModelV3Prompt, target: string): boolean {
  return prompt.some((message) => summarizeContent(message).includes(target));
}

function listTexts(prompt: LanguageModelV3Prompt): string[] {
  return prompt.map((message, index) => `${String(index).padStart(2, "0")} ${message.role}: ${summarizeContent(message)}`);
}

async function fetchTrace(traceId: string, jaegerUrl: string): Promise<JaegerSpan[]> {
  const response = await fetch(`${jaegerUrl}/api/traces/${traceId}`);
  if (!response.ok) {
    throw new Error(`Jaeger request failed: ${response.status} ${response.statusText}`);
  }

  const body = await response.json() as TraceResponse;
  return body.data?.[0]?.spans ?? [];
}

function selectAiSpan(spans: JaegerSpan[], aiSpanId: string, targetText: string): JaegerSpan {
  const candidates = spans.filter((span) => typeof getTag(span, "ai.prompt") === "string");

  if (aiSpanId.length > 0) {
    const exact = candidates.find((span) => span.spanID === aiSpanId);
    if (!exact) {
      throw new Error(`AI span ${aiSpanId} not found`);
    }
    return exact;
  }

  const matching = candidates
    .map((span) => ({
      span,
      prompt: String(getTag(span, "ai.prompt") ?? ""),
    }))
    .filter(({ prompt }) => prompt.includes(targetText))
    .sort((left, right) => right.span.startTime - left.span.startTime);

  if (matching.length > 0) {
    return matching[0].span;
  }

  const latest = candidates.sort((left, right) => right.startTime - left.startTime)[0];
  if (!latest) {
    throw new Error("No ai.prompt span found in trace");
  }
  return latest;
}

function buildScratchpadStateFromTrace(spans: JaegerSpan[], options: {
  conversationId: string;
  agentLabel: string;
  aiSpanStartTime: number;
}): ScratchpadState | undefined {
  const matching = spans
    .filter((span) => span.operationName === "ai.toolCall.scratchpad" && span.startTime <= options.aiSpanStartTime)
    .map((span) => {
      const requestContextJson = getLogFieldValues(span, "context_management.request_context_json")
        .find((value) => typeof value === "string");
      const requestContext = requestContextJson
        ? parseJson<{ conversationId?: string }>(requestContextJson, "context_management.request_context_json")
        : undefined;

      return {
        span,
        requestContext,
      };
    })
    .filter(({ requestContext }) => requestContext?.conversationId === options.conversationId)
    .sort((left, right) => right.span.startTime - left.span.startTime);

  const latest = matching[0]?.span;
  if (!latest) {
    return undefined;
  }

  const args = parseJson<{
    description?: string;
    setEntries?: Record<string, string>;
    replaceEntries?: Record<string, string>;
    preserveTurns?: number | null;
    omitToolCallIds?: string[];
  }>(getTag(latest, "ai.toolCall.args"), "ai.toolCall.args");

  const entries = args.replaceEntries ?? args.setEntries;

  return {
    ...(entries ? { entries } : {}),
    ...(args.preserveTurns !== undefined ? { preserveTurns: args.preserveTurns ?? undefined } : {}),
    ...(args.description
      ? {
        activeNotice: {
          description: args.description,
          toolCallId: String(getTag(latest, "ai.toolCall.id") ?? latest.spanID),
          rawTurnCountAtCall: 0,
          projectedTurnCountAtCall: 0,
        },
      }
      : {}),
    omitToolCallIds: args.omitToolCallIds ?? [],
    agentLabel: options.agentLabel,
  };
}

async function runScenario(name: string, prompt: LanguageModelV3Prompt, scratchpadState: ScratchpadState | undefined, options: {
  conversationId: string;
  agentId: string;
  agentLabel: string;
  targetText: string;
}): Promise<void> {
  const store = new InMemoryScratchpadStore();
  if (scratchpadState) {
    await store.set(
      { conversationId: options.conversationId, agentId: options.agentId },
      scratchpadState
    );
  }

  const telemetry: ContextManagementTelemetryEvent[] = [];
  const runtime = createContextManagementRuntime({
    strategies: [
      new ScratchpadStrategy({ scratchpadStore: store }),
    ],
    telemetry: (event) => {
      telemetry.push(event);
    },
  });

  const transformed = await runtime.middleware.transformParams?.({
    params: {
      prompt,
      providerOptions: {
        [CONTEXT_MANAGEMENT_KEY]: {
          conversationId: options.conversationId,
          agentId: options.agentId,
          agentLabel: options.agentLabel,
        },
      },
    },
    model: {
      specificationVersion: "v3",
      provider: "replay",
      modelId: "replay",
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error("unused");
      },
      doStream: async () => {
        throw new Error("unused");
      },
    },
  } as never);

  const nextPrompt = transformed?.prompt ?? prompt;
  const complete = telemetry.find((event) => event.type === "runtime-complete");

  console.log(`\n=== ${name} ===`);
  console.log(`scratchpadState=${JSON.stringify(scratchpadState ?? null)}`);
  console.log(`before.messages=${prompt.length} before.nonSystem=${nonSystemCount(prompt)} before.containsTarget=${containsText(prompt, options.targetText)}`);
  console.log(`after.messages=${nextPrompt.length} after.nonSystem=${nonSystemCount(nextPrompt)} after.containsTarget=${containsText(nextPrompt, options.targetText)}`);

  if (complete?.type === "runtime-complete") {
    console.log(`telemetry.messageCountBefore=${complete.messageCountBefore} telemetry.messageCountAfter=${complete.messageCountAfter}`);
  }

  console.log("after.prompt");
  for (const line of listTexts(nextPrompt)) {
    console.log(line);
  }
}

async function main(): Promise<void> {
  const jaegerUrl = env("JAEGER_URL", DEFAULTS.jaegerUrl);
  const traceId = env("TRACE_ID", DEFAULTS.traceId);
  const aiSpanId = env("AI_SPAN_ID", DEFAULTS.aiSpanId);
  const targetText = env("TARGET_TEXT", DEFAULTS.targetText);
  const conversationId = env("CONVERSATION_ID", DEFAULTS.conversationId);
  const agentId = env("AGENT_ID", DEFAULTS.agentId);
  const agentLabel = env("AGENT_LABEL", DEFAULTS.agentLabel);

  const spans = await fetchTrace(traceId, jaegerUrl);
  const aiSpan = selectAiSpan(spans, aiSpanId, targetText);
  const aiPrompt = parseJson<{ messages: AiPromptMessage[] }>(
    getTag(aiSpan, "ai.prompt"),
    "ai.prompt"
  );
  const prompt = aiPrompt.messages.map(toPromptMessage);
  const tracedScratchpadState = buildScratchpadStateFromTrace(spans, {
    conversationId,
    agentLabel,
    aiSpanStartTime: aiSpan.startTime,
  });

  console.log(`traceId=${traceId}`);
  console.log(`aiSpanId=${aiSpan.spanID}`);
  console.log(`conversationId=${conversationId}`);
  console.log(`selectedAiOperation=${aiSpan.operationName}`);

  await runScenario("no scratchpad state", prompt, undefined, {
    conversationId,
    agentId,
    agentLabel,
    targetText,
  });

  await runScenario("traced scratchpad state", prompt, tracedScratchpadState, {
    conversationId,
    agentId,
    agentLabel,
    targetText,
  });

  if (tracedScratchpadState) {
    await runScenario("same scratchpad but preserveTurns=1", prompt, {
      ...tracedScratchpadState,
      preserveTurns: 1,
    }, {
      conversationId,
      agentId,
      agentLabel,
      targetText,
    });
  }
}

await main();
