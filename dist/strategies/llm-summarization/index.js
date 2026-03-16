import { generateText } from "ai";
const DEFAULT_SUMMARY_SYSTEM_PROMPT = "Compress older agent context into a concise factual summary. Preserve exact file paths, tool names, command names, errors, decisions, open questions, and TODOs. Do not invent details. Return plain text with short sections for Key Findings, Files/Artifacts, Errors, Decisions, Open Questions, and TODOs.";
const DEFAULT_MAX_OUTPUT_TOKENS = 1200;
const DEFAULT_MAX_TRANSCRIPT_CHARS = 12000;
const DEFAULT_DETERMINISTIC_SUMMARY_MAX_CHARS = 4000;
const DEFAULT_MAX_PART_CHARS = 600;
function resolveFormattingOptions(formatting) {
    return {
        maxTranscriptChars: Math.max(1, Math.floor(formatting?.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS)),
        maxPartChars: Math.max(1, Math.floor(formatting?.maxPartChars ?? DEFAULT_MAX_PART_CHARS)),
        deterministicSummaryMaxChars: Math.max(1, Math.floor(formatting?.deterministicSummaryMaxChars ??
            DEFAULT_DETERMINISTIC_SUMMARY_MAX_CHARS)),
    };
}
function clipText(text, maxChars) {
    if (text.length <= maxChars) {
        return text;
    }
    return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}
function stringifyUnknown(value) {
    if (typeof value === "string") {
        return value;
    }
    try {
        return JSON.stringify(value) ?? "";
    }
    catch {
        return String(value);
    }
}
function formatToolResultOutput(output) {
    if (output.type === "text") {
        return output.value;
    }
    return stringifyUnknown(output);
}
function formatSummaryPart(part, maxPartChars) {
    if (typeof part === "string") {
        return clipText(part, maxPartChars);
    }
    const text = (() => {
        switch (part.type) {
            case "text":
            case "reasoning":
                return part.text;
            case "tool-call":
                return `[Tool call ${part.toolName}#${part.toolCallId}] ${stringifyUnknown(part.input)}`;
            case "tool-result":
                return `[Tool result ${part.toolName}#${part.toolCallId}] ${formatToolResultOutput(part.output)}`;
            case "file":
                return `[File ${part.filename ?? "unnamed"} (${part.mediaType})]`;
            case "tool-approval-response":
                return `[Tool approval ${part.approved ? "approved" : "denied"}#${part.approvalId}]${part.reason ? ` ${part.reason}` : ""}`;
            default:
                return stringifyUnknown(part);
        }
    })();
    return clipText(text, maxPartChars);
}
function formatMessageForSummary(message, formatting) {
    if (message.role === "system") {
        return `[SYSTEM]\n${clipText(message.content, formatting.maxPartChars)}`;
    }
    const formattedParts = message.content
        .map((part) => formatSummaryPart(part, formatting.maxPartChars))
        .filter((part) => part.length > 0)
        .join("\n");
    return `[${message.role.toUpperCase()}]\n${formattedParts}`;
}
export function buildSummaryTranscript(messages, formatting) {
    const resolvedFormatting = resolveFormattingOptions(formatting);
    const transcript = messages
        .map((message, index) => `## Message ${index + 1}\n${formatMessageForSummary(message, resolvedFormatting)}`)
        .join("\n\n");
    return clipText(transcript, resolvedFormatting.maxTranscriptChars);
}
export function buildDeterministicSummary(messages, formatting) {
    const resolvedFormatting = resolveFormattingOptions(formatting);
    const lines = ["Compressed history (deterministic fallback):"];
    let remaining = resolvedFormatting.deterministicSummaryMaxChars - lines[0].length;
    for (const message of messages) {
        if (remaining <= 0) {
            break;
        }
        const candidate = `- ${formatMessageForSummary(message, resolvedFormatting).replace(/\s+/g, " ")}`;
        const clipped = clipText(candidate, Math.min(remaining, resolvedFormatting.maxPartChars));
        lines.push(clipped);
        remaining -= clipped.length + 1;
    }
    return lines.join("\n");
}
export function createLlmSummarizer(options) {
    const formatting = resolveFormattingOptions();
    const systemPrompt = DEFAULT_SUMMARY_SYSTEM_PROMPT;
    return async (messages) => {
        const transcript = buildSummaryTranscript(messages, formatting);
        const deterministicFallback = buildDeterministicSummary(messages, formatting);
        const summaryPrompt = [
            {
                role: "system",
                content: systemPrompt,
            },
            {
                role: "user",
                content: `Summarize this older context for future continuation:\n\n${transcript}`,
            },
        ];
        try {
            const { text } = await generateText({
                model: options.model,
                messages: summaryPrompt,
                maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
                temperature: 0,
            });
            const summary = text.trim();
            return summary.length > 0 ? summary : deterministicFallback;
        }
        catch {
            return deterministicFallback;
        }
    };
}
