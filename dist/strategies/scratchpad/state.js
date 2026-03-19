export function dedupeStrings(values) {
    const seen = new Set();
    const deduped = [];
    for (const value of values) {
        if (typeof value !== "string" || value.length === 0 || seen.has(value)) {
            continue;
        }
        seen.add(value);
        deduped.push(value);
    }
    return deduped;
}
export function normalizeKeepLastMessages(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return undefined;
    }
    return Math.max(0, Math.floor(value));
}
export function normalizeAnchorToolCallId(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
}
export function normalizeEntryMap(value) {
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
        return [nextKey, nextValue];
    })
        .filter((entry) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right));
    if (normalized.length === 0) {
        return undefined;
    }
    return Object.fromEntries(normalized);
}
export function mergeEntryMaps(currentEntries, nextEntries) {
    return normalizeEntryMap({
        ...(currentEntries ?? {}),
        ...(nextEntries ?? {}),
    });
}
export function removeEntryKeys(entries, keys) {
    if (!entries || !keys || keys.length === 0) {
        return entries;
    }
    const nextEntries = { ...entries };
    for (const key of keys) {
        const normalizedKey = key.trim();
        if (normalizedKey.length > 0) {
            delete nextEntries[normalizedKey];
        }
    }
    return normalizeEntryMap(nextEntries);
}
export function countEntryChars(entries) {
    if (!entries) {
        return 0;
    }
    return Object.entries(entries).reduce((total, [key, value]) => total + key.length + value.length, 0);
}
export function indentMultiline(value, prefix = "  ") {
    return value
        .split("\n")
        .map((line) => `${prefix}${line}`)
        .join("\n");
}
export function renderScratchpadState(state) {
    const lines = [];
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
        }
        else {
            lines.push(`${key}: ${value}`);
        }
    }
    return lines;
}
export function normalizeScratchpadState(state, agentLabel) {
    const legacyNotes = typeof state?.notes === "string"
        ? (state.notes?.trim() ?? "")
        : "";
    const entries = normalizeEntryMap({
        ...(state?.entries ?? {}),
        ...(legacyNotes.length > 0 && state?.entries?.notes === undefined ? { notes: legacyNotes } : {}),
    });
    return {
        ...(entries ? { entries } : {}),
        keepLastMessages: normalizeKeepLastMessages(state?.keepLastMessages),
        keepLastMessagesAnchorToolCallId: normalizeAnchorToolCallId(state?.keepLastMessagesAnchorToolCallId),
        omitToolCallIds: dedupeStrings(state?.omitToolCallIds ?? []),
        ...(typeof state?.updatedAt === "number" ? { updatedAt: state.updatedAt } : {}),
        ...(state?.agentLabel || agentLabel ? { agentLabel: state?.agentLabel ?? agentLabel } : {}),
    };
}
