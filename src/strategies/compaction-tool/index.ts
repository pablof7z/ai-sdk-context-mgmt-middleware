import type { LanguageModelV3Message, LanguageModelV3Prompt } from "@ai-sdk/provider";
import type { ToolSet } from "ai";
import {
  clonePrompt,
  collectToolExchanges,
  partitionPromptForSummarization,
} from "../../prompt-utils.js";
import type {
  CompactionEdit,
  CompactionOnCompactArgs,
  CompactionState,
  CompactionStore,
  CompactionStoreKey,
  CompactionToolStrategyOptions,
  ContextManagementRequestContext,
  ContextManagementStrategy,
  ContextManagementStrategyExecution,
  ContextManagementStrategyState,
  RemovedToolExchange,
} from "../../types.js";
import { createCompactContextTool } from "./tools/compact-context.js";
import {
  buildCompactionSummaryMessage,
  extractCompactionSummaryRange,
  extractMessageAnchor,
  resolveAnchorIndex,
} from "./shared.js";

const DEFAULT_PRESERVE_RECENT_MESSAGES = 8;

type ResolvedCompactionEdit = {
  edit: CompactionEdit;
  startIndex: number;
  endIndex: number;
};

function buildCompactionKey(context: ContextManagementRequestContext): CompactionStoreKey {
  return {
    conversationId: context.conversationId,
    agentId: context.agentId,
  };
}

function buildCompactionRequestKey(context: ContextManagementRequestContext): string {
  return `${context.conversationId}:${context.agentId}`;
}

function cloneCompactionAnchor(anchor: CompactionEdit["start"]): CompactionEdit["start"] {
  return {
    ...(anchor.sourceRecordId ? { sourceRecordId: anchor.sourceRecordId } : {}),
    ...(anchor.eventId ? { eventId: anchor.eventId } : {}),
    ...(anchor.messageId ? { messageId: anchor.messageId } : {}),
  };
}

function cloneCompactionEdit(edit: CompactionEdit): CompactionEdit {
  return {
    ...edit,
    start: cloneCompactionAnchor(edit.start),
    end: cloneCompactionAnchor(edit.end),
  };
}

function cloneCompactionState(
  state: CompactionState | undefined,
  agentLabel?: string
): CompactionState {
  const edits = Array.isArray(state?.edits)
    ? state!.edits
      .filter((edit) => typeof edit?.replacement === "string" && edit.replacement.trim().length > 0)
      .map((edit) => cloneCompactionEdit(edit))
    : [];

  return {
    edits,
    ...(typeof state?.updatedAt === "number" && Number.isFinite(state.updatedAt)
      ? { updatedAt: state.updatedAt }
      : {}),
    ...(state?.agentLabel
      ? { agentLabel: state.agentLabel }
      : agentLabel
        ? { agentLabel }
        : {}),
  };
}

function sortEditsByCreatedAt(edits: readonly CompactionEdit[]): CompactionEdit[] {
  return [...edits].sort((left, right) =>
    left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  );
}

function computeRemovedToolExchanges(
  originalPrompt: LanguageModelV3Prompt,
  nextPrompt: LanguageModelV3Prompt
): RemovedToolExchange[] {
  const original = collectToolExchanges(originalPrompt);
  const next = collectToolExchanges(nextPrompt);
  const removed: RemovedToolExchange[] = [];

  for (const exchange of original.values()) {
    if (next.has(exchange.toolCallId)) {
      continue;
    }

    removed.push({
      toolCallId: exchange.toolCallId,
      toolName: exchange.toolName,
      reason: "compaction",
    });
  }

  return removed;
}

function resolveSingleEdit(
  prompt: LanguageModelV3Prompt,
  edit: CompactionEdit
): ResolvedCompactionEdit | undefined {
  const startIndex = resolveAnchorIndex(prompt, edit.start);
  const endIndex = resolveAnchorIndex(prompt, edit.end);

  if (startIndex === undefined || endIndex === undefined || startIndex > endIndex) {
    return undefined;
  }

  return {
    edit,
    startIndex,
    endIndex,
  };
}

function resolveStoredEdits(
  prompt: LanguageModelV3Prompt,
  edits: readonly CompactionEdit[]
): {
  resolved: ResolvedCompactionEdit[];
  staleEditIds: string[];
} {
  const staleEditIds: string[] = [];
  const resolved = sortEditsByCreatedAt(edits)
    .flatMap((edit) => {
      const resolvedEdit = resolveSingleEdit(prompt, edit);
      if (!resolvedEdit) {
        staleEditIds.push(edit.id);
        return [];
      }

      return [resolvedEdit];
    })
    .sort((left, right) =>
      left.startIndex - right.startIndex
      || right.endIndex - left.endIndex
      || left.edit.createdAt - right.edit.createdAt
    );

  const normalized: ResolvedCompactionEdit[] = [];

  for (const candidate of resolved) {
    const previous = normalized.at(-1);
    if (!previous || candidate.startIndex > previous.endIndex) {
      normalized.push(candidate);
      continue;
    }

    const keepCandidate =
      candidate.edit.createdAt > previous.edit.createdAt
      || (
        candidate.edit.createdAt === previous.edit.createdAt
        && candidate.endIndex - candidate.startIndex >= previous.endIndex - previous.startIndex
      );

    staleEditIds.push(keepCandidate ? previous.edit.id : candidate.edit.id);
    if (keepCandidate) {
      normalized[normalized.length - 1] = candidate;
    }
  }

  return {
    resolved: normalized,
    staleEditIds,
  };
}

function applyResolvedEdits(
  prompt: LanguageModelV3Prompt,
  resolvedEdits: readonly ResolvedCompactionEdit[]
): LanguageModelV3Prompt {
  if (resolvedEdits.length === 0) {
    return clonePrompt(prompt);
  }

  const nextPrompt: LanguageModelV3Prompt = [];
  let editIndex = 0;
  let promptIndex = 0;

  while (promptIndex < prompt.length) {
    const currentEdit = resolvedEdits[editIndex];
    if (currentEdit && promptIndex === currentEdit.startIndex) {
      nextPrompt.push(buildCompactionSummaryMessage(currentEdit.edit));
      promptIndex = currentEdit.endIndex + 1;
      editIndex += 1;
      continue;
    }

    nextPrompt.push(clonePrompt([prompt[promptIndex]])[0]);
    promptIndex += 1;
  }

  return nextPrompt;
}

function buildCompactionPayload(
  mode: "manual" | "auto" | "stored",
  prompt: LanguageModelV3Prompt,
  edits: readonly CompactionEdit[]
): ContextManagementStrategyExecution["payloads"] {
  const resolved = resolveStoredEdits(prompt, edits).resolved;
  const first = resolved[0];
  const last = resolved.at(-1);

  return {
    kind: "compaction-tool",
    mode,
    editCount: edits.length,
    compactedMessageCount: edits.reduce((total, edit) => total + edit.compactedMessageCount, 0),
    ...(first ? { fromIndex: first.startIndex } : {}),
    ...(last ? { toIndex: last.endIndex } : {}),
    summaryCharCount: edits.reduce((total, edit) => total + edit.replacement.length, 0),
  };
}

function rangesOverlap(
  left: ResolvedCompactionEdit,
  right: ResolvedCompactionEdit
): boolean {
  return left.startIndex <= right.endIndex && right.startIndex <= left.endIndex;
}

function mergeCompactionEdit(
  prompt: LanguageModelV3Prompt,
  existingEdits: readonly CompactionEdit[],
  nextEdit: CompactionEdit
): CompactionEdit[] {
  const resolvedNext = resolveSingleEdit(prompt, nextEdit);
  if (!resolvedNext) {
    return sortEditsByCreatedAt(existingEdits);
  }

  const remaining = existingEdits.filter((existingEdit) => {
    const resolvedExisting = resolveSingleEdit(prompt, existingEdit);
    return resolvedExisting ? !rangesOverlap(resolvedExisting, resolvedNext) : false;
  });

  return sortEditsByCreatedAt([...remaining, cloneCompactionEdit(nextEdit)]);
}

function extractVisibleMessageRange(message: LanguageModelV3Message): {
  start: CompactionEdit["start"];
  end: CompactionEdit["end"];
} | undefined {
  const summaryRange = extractCompactionSummaryRange(message);
  if (summaryRange) {
    return {
      start: cloneCompactionAnchor(summaryRange.start),
      end: cloneCompactionAnchor(summaryRange.end),
    };
  }

  const anchor = extractMessageAnchor(message);
  if (!anchor) {
    return undefined;
  }

  return {
    start: anchor,
    end: anchor,
  };
}

function buildAutoCompactionEdit(
  visiblePrompt: LanguageModelV3Prompt,
  messagesToCompact: readonly LanguageModelV3Message[],
  replacement: string
): CompactionEdit | undefined {
  if (messagesToCompact.length === 0) {
    return undefined;
  }

  const firstRange = extractVisibleMessageRange(messagesToCompact[0]);
  const lastRange = extractVisibleMessageRange(messagesToCompact[messagesToCompact.length - 1]);
  if (!firstRange || !lastRange) {
    return undefined;
  }

  const fromIndex = visiblePrompt.findIndex((message) => {
    const range = extractVisibleMessageRange(message);
    return range
      ? JSON.stringify(range.start) === JSON.stringify(firstRange.start)
      : false;
  });
  const normalizedToIndex = [...visiblePrompt].reverse().findIndex((message) => {
    const range = extractVisibleMessageRange(message);
    return range
      ? JSON.stringify(range.end) === JSON.stringify(lastRange.end)
      : false;
  });
  const toIndex = normalizedToIndex === -1
    ? undefined
    : visiblePrompt.length - 1 - normalizedToIndex;

  return {
    id: `compact:auto:${Date.now()}`,
    source: "auto",
    start: cloneCompactionAnchor(firstRange.start),
    end: cloneCompactionAnchor(lastRange.end),
    replacement,
    createdAt: Date.now(),
    compactedMessageCount:
      fromIndex === -1 || toIndex === undefined || toIndex < fromIndex
        ? messagesToCompact.length
        : toIndex - fromIndex + 1,
  };
}

export class CompactionToolStrategy implements ContextManagementStrategy {
  readonly name = "compaction-tool";
  private readonly shouldCompact?: NonNullable<CompactionToolStrategyOptions["shouldCompact"]>;
  private readonly onCompact?: NonNullable<CompactionToolStrategyOptions["onCompact"]>;
  private readonly preserveRecentMessages: number;
  private readonly compactionStore?: CompactionStore;
  private readonly optionalTools: ToolSet;
  private readonly pendingManualEdits = new Map<string, CompactionEdit[]>();

  constructor(options: CompactionToolStrategyOptions) {
    if (options.shouldCompact && !options.onCompact) {
      throw new Error("CompactionToolStrategy requires both shouldCompact and onCompact for auto-compaction");
    }

    this.shouldCompact = options.shouldCompact;
    this.onCompact = options.onCompact;
    this.preserveRecentMessages = Math.max(
      0,
      Math.floor(options.preserveRecentMessages ?? DEFAULT_PRESERVE_RECENT_MESSAGES)
    );
    this.compactionStore = options.compactionStore;
    this.optionalTools = {
      compact_context: createCompactContextTool({
        queueEdit: (requestContext, edit) => {
          if (!this.onCompact) {
            return "compact_context is unavailable because no host compaction summarizer is configured.";
          }
          const requestKey = buildCompactionRequestKey(requestContext);
          const current = this.pendingManualEdits.get(requestKey) ?? [];
          this.pendingManualEdits.set(requestKey, [...current, cloneCompactionEdit(edit)]);
          return true;
        },
      }),
    };
  }

  getOptionalTools(): ToolSet {
    return this.optionalTools;
  }

  async apply(state: ContextManagementStrategyState): Promise<ContextManagementStrategyExecution> {
    const originalPrompt = clonePrompt(state.prompt);
    const key = buildCompactionKey(state.requestContext);
    const requestKey = buildCompactionRequestKey(state.requestContext);
    const pendingManualEdits = this.pendingManualEdits.get(requestKey) ?? [];

    let storeState = cloneCompactionState(
      this.compactionStore ? await this.compactionStore.get(key) : undefined,
      state.requestContext.agentLabel
    );
    const originalStoredEditIds = storeState.edits.map((edit) => edit.id).join(",");

    const storedResolution = resolveStoredEdits(originalPrompt, storeState.edits);
    if (storedResolution.staleEditIds.length > 0) {
      const staleEditIds = new Set(storedResolution.staleEditIds);
      storeState = {
        ...storeState,
        edits: storeState.edits.filter((edit) => !staleEditIds.has(edit.id)),
        updatedAt: Date.now(),
      };
    }

    let visiblePrompt = applyResolvedEdits(originalPrompt, resolveStoredEdits(originalPrompt, storeState.edits).resolved);
    let finalReason = "no-compaction-requested";
    let finalPayload: ContextManagementStrategyExecution["payloads"] | undefined;
    let persistStore = storedResolution.staleEditIds.length > 0;

    if (pendingManualEdits.length > 0) {
      let mergedEdits = storeState.edits;
      const appliedManualEdits: CompactionEdit[] = [];

      for (const manualEdit of pendingManualEdits) {
        if (!this.onCompact) {
          finalReason = "manual-compaction-unavailable";
          this.pendingManualEdits.delete(requestKey);
          break;
        }
        const resolvedSpan = resolveSingleEdit(visiblePrompt, manualEdit);
        if (!resolvedSpan) {
          continue;
        }

        const replacement = (await this.onCompact({
          state,
          prompt: visiblePrompt,
          messages: visiblePrompt.slice(
            resolvedSpan.startIndex,
            resolvedSpan.endIndex + 1
          ) as LanguageModelV3Message[],
          requestContext: state.requestContext,
          mode: "manual",
          steeringMessage: manualEdit.steeringMessage,
        } satisfies CompactionOnCompactArgs)).trim();
        if (replacement.length === 0) {
          continue;
        }
        const resolvedManualEdit: CompactionEdit = {
          ...manualEdit,
          replacement,
        };
        const beforeMerge = mergedEdits.map((edit) => edit.id).join(",");
        mergedEdits = mergeCompactionEdit(originalPrompt, mergedEdits, resolvedManualEdit);
        if (mergedEdits.map((edit) => edit.id).join(",") !== beforeMerge || mergedEdits.some((edit) => edit.id === resolvedManualEdit.id)) {
          appliedManualEdits.push(resolvedManualEdit);
        }
      }

      if (appliedManualEdits.length > 0) {
        storeState = {
          ...storeState,
          edits: mergedEdits,
          updatedAt: Date.now(),
        };
        visiblePrompt = applyResolvedEdits(
          originalPrompt,
          resolveStoredEdits(originalPrompt, storeState.edits).resolved
        );
        finalReason = "manual-compaction-applied";
        finalPayload = buildCompactionPayload("manual", originalPrompt, appliedManualEdits);
        persistStore = true;
      } else {
        finalReason = "manual-compaction-skipped";
      }
      this.pendingManualEdits.delete(requestKey);
    } else if (this.shouldCompact && this.onCompact) {
      const shouldCompact = await this.shouldCompact({
        state,
        prompt: visiblePrompt,
      });

      if (shouldCompact) {
        const {
          summarizableMessages,
        } = partitionPromptForSummarization(
          visiblePrompt,
          this.preserveRecentMessages,
          state.pinnedToolCallIds
        );

        if (summarizableMessages.length > 0) {
          const replacement = (await this.onCompact({
            state,
            prompt: visiblePrompt,
            messages: summarizableMessages,
            requestContext: state.requestContext,
            mode: "auto",
          } satisfies CompactionOnCompactArgs)).trim();

          if (replacement.length > 0) {
            const autoEdit = buildAutoCompactionEdit(visiblePrompt, summarizableMessages, replacement);
            if (autoEdit) {
              storeState = {
                ...storeState,
                edits: mergeCompactionEdit(originalPrompt, storeState.edits, autoEdit),
                updatedAt: Date.now(),
              };
              visiblePrompt = applyResolvedEdits(
                originalPrompt,
                resolveStoredEdits(originalPrompt, storeState.edits).resolved
              );
              finalReason = "auto-compaction-applied";
              finalPayload = buildCompactionPayload("auto", originalPrompt, [autoEdit]);
              persistStore = true;
            } else {
              finalReason = "auto-compaction-unresolved";
            }
          } else {
            finalReason = "auto-compaction-empty-summary";
          }
        } else {
          finalReason = "no-compaction-candidates";
        }
      }
    }

    const finalStoreEditIds = storeState.edits.map((edit) => edit.id).join(",");
    if (finalReason === "no-compaction-requested" && storeState.edits.length > 0) {
      finalReason = "stored-compactions-reapplied";
      finalPayload = buildCompactionPayload("stored", originalPrompt, storeState.edits);
    }

    if (this.compactionStore && (persistStore || originalStoredEditIds !== finalStoreEditIds)) {
      await this.compactionStore.set(key, cloneCompactionState(storeState, state.requestContext.agentLabel));
    }

    const removedExchanges = computeRemovedToolExchanges(originalPrompt, visiblePrompt);
    state.updatePrompt(visiblePrompt);
    state.addRemovedToolExchanges(removedExchanges);

    return {
      outcome: finalPayload ? "applied" : "skipped",
      reason: finalReason,
      payloads: finalPayload,
    };
  }
}
