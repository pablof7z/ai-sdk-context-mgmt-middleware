import type { ScratchpadState } from "../../types.js";

export function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || seen.has(value)) {
      continue;
    }

    seen.add(value);
    deduped.push(value);
  }

  return deduped;
}

export function normalizePreserveTurns(value: number | null | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(0, Math.floor(value));
}

function normalizeNonEmptyString(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeScratchpadUseNotice(
  value: ScratchpadState["activeNotice"] | undefined
): ScratchpadState["activeNotice"] {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const description = normalizeNonEmptyString(value.description);
  const toolCallId = normalizeNonEmptyString(value.toolCallId);
  const rawTurnCountAtCall = typeof value.rawTurnCountAtCall === "number" && Number.isFinite(value.rawTurnCountAtCall)
    ? Math.max(0, Math.floor(value.rawTurnCountAtCall))
    : undefined;
  const projectedTurnCountAtCall =
    typeof value.projectedTurnCountAtCall === "number" && Number.isFinite(value.projectedTurnCountAtCall)
      ? Math.max(0, Math.floor(value.projectedTurnCountAtCall))
    : undefined;

  if (!description || !toolCallId || rawTurnCountAtCall === undefined || projectedTurnCountAtCall === undefined) {
    return undefined;
  }

  return {
    description,
    toolCallId,
    rawTurnCountAtCall,
    projectedTurnCountAtCall,
  };
}

export function normalizeEntryMap(
  value: Record<string, unknown> | undefined
): Record<string, string> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const normalized = Object.entries(value)
    .map(([key, entryValue]) => {
      if (typeof entryValue !== "string") {
        return undefined;
      }

      const nextKey = key.trim();
      const nextValue = entryValue.trim();

      if (nextKey.length === 0 || nextValue.length === 0) {
        return undefined;
      }

      return [nextKey, nextValue] as const;
    })
    .filter((entry): entry is readonly [string, string] => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));

  if (normalized.length === 0) {
    return undefined;
  }

  return Object.fromEntries(normalized);
}

export function mergeEntryMaps(
  currentEntries: Record<string, string> | undefined,
  nextEntries: Record<string, string> | undefined
): Record<string, string> | undefined {
  return normalizeEntryMap({
    ...(currentEntries ?? {}),
    ...(nextEntries ?? {}),
  });
}

export function removeEntryKeys(
  entries: Record<string, string> | undefined,
  keys: readonly string[] | undefined
): Record<string, string> | undefined {
  if (!entries || !keys || keys.length === 0) {
    return entries;
  }

  const nextEntries: Record<string, string> = { ...entries };
  for (const key of keys) {
    const normalizedKey = key.trim();
    if (normalizedKey.length > 0) {
      delete nextEntries[normalizedKey];
    }
  }

  return normalizeEntryMap(nextEntries);
}

export function countEntryChars(entries: Record<string, string> | undefined): number {
  if (!entries) {
    return 0;
  }

  return Object.entries(entries).reduce(
    (total, [key, value]) => total + key.length + value.length,
    0
  );
}

export function indentMultiline(value: string, prefix = "  "): string {
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

export function renderScratchpadState(state: ScratchpadState): string[] {
  const lines: string[] = [];
  const entries = state.entries ?? {};
  const entryItems = Object.entries(entries);

  if (entryItems.length === 0) {
    lines.push("(empty)");
    return lines;
  }

  for (const [key, value] of entryItems) {
    if (value.includes("\n")) {
      lines.push(`${key}:`);
      lines.push(indentMultiline(value));
    } else {
      lines.push(`${key}: ${value}`);
    }
  }

  return lines;
}

export function normalizeScratchpadState(
  state: ScratchpadState | undefined,
  agentLabel?: string
): ScratchpadState {
  const legacyNotes = typeof (state as ScratchpadState & { notes?: unknown } | undefined)?.notes === "string"
    ? ((state as ScratchpadState & { notes?: string }).notes?.trim() ?? "")
    : "";
  const entries = normalizeEntryMap({
    ...(state?.entries ?? {}),
    ...(legacyNotes.length > 0 && state?.entries?.notes === undefined ? { notes: legacyNotes } : {}),
  });
  const activeNotice = normalizeScratchpadUseNotice(state?.activeNotice);
  return {
    ...(entries ? { entries } : {}),
    preserveTurns: normalizePreserveTurns(state?.preserveTurns),
    ...(activeNotice ? { activeNotice } : {}),
    omitToolCallIds: dedupeStrings(state?.omitToolCallIds ?? []),
    ...(typeof state?.updatedAt === "number" ? { updatedAt: state.updatedAt } : {}),
    ...(state?.agentLabel || agentLabel ? { agentLabel: state?.agentLabel ?? agentLabel } : {}),
  };
}
