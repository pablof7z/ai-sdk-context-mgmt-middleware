const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD_TOKENS = 4;
function estimateString(text) {
    if (text.length === 0) {
        return 0;
    }
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}
function safeStringify(value) {
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
function estimateToolResultOutput(output) {
    if (output.type === "text") {
        return estimateString(output.value);
    }
    return estimateString(safeStringify(output));
}
export function createDefaultPromptTokenEstimator() {
    return {
        estimateMessage(message) {
            if (message.role === "system") {
                return MESSAGE_OVERHEAD_TOKENS + estimateString(message.content);
            }
            let total = MESSAGE_OVERHEAD_TOKENS;
            for (const part of message.content) {
                switch (part.type) {
                    case "text":
                    case "reasoning":
                        total += estimateString(part.text) + 1;
                        break;
                    case "file":
                        total += estimateString(part.filename ?? "");
                        total += estimateString(part.mediaType);
                        total += 16;
                        break;
                    case "tool-call":
                        total += estimateString(part.toolName);
                        total += estimateString(safeStringify(part.input));
                        total += 6;
                        break;
                    case "tool-result":
                        total += estimateString(part.toolName);
                        total += estimateToolResultOutput(part.output);
                        total += 6;
                        break;
                    case "tool-approval-response":
                        total += 8;
                        break;
                }
            }
            return total;
        },
        estimatePrompt(prompt) {
            return prompt.reduce((sum, message) => sum + this.estimateMessage(message), 0);
        },
        estimateTools(tools) {
            if (!tools || tools.length === 0) {
                return 0;
            }
            let total = 0;
            for (const tool of tools) {
                if (tool.type === "function") {
                    total += estimateString(tool.name);
                    total += estimateString(tool.description ?? "");
                    total += estimateString(safeStringify(tool.inputSchema));
                    total += 6; // overhead per tool definition
                }
                else {
                    // Provider-defined tools — estimate from the full serialized form
                    total += estimateString(safeStringify(tool));
                }
            }
            return total;
        },
    };
}
