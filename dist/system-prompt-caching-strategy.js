import { clonePrompt, isContextManagementSystemMessage } from "./prompt-utils.js";
export class SystemPromptCachingStrategy {
    name = "system-prompt-caching";
    consolidateSystemMessages;
    constructor(options = {}) {
        this.consolidateSystemMessages = options.consolidateSystemMessages ?? true;
    }
    apply(state) {
        const prompt = clonePrompt(state.prompt);
        const systemMessages = prompt.filter((message) => message.role === "system");
        const nonSystemMessages = prompt.filter((message) => message.role !== "system");
        if (systemMessages.length === 0) {
            return {
                reason: "no-system-messages",
            };
        }
        const taggedSystemMessages = systemMessages.filter((message) => isContextManagementSystemMessage(message));
        const plainSystemMessages = systemMessages.filter((message) => !isContextManagementSystemMessage(message));
        let reorderedSystemMessages;
        if (this.consolidateSystemMessages && plainSystemMessages.length > 1) {
            const consolidatedContent = plainSystemMessages
                .map((message) => message.content)
                .join("\n\n");
            reorderedSystemMessages = [
                { role: "system", content: consolidatedContent },
                ...taggedSystemMessages,
            ];
        }
        else {
            reorderedSystemMessages = [...plainSystemMessages, ...taggedSystemMessages];
        }
        state.updatePrompt([...reorderedSystemMessages, ...nonSystemMessages]);
        return {
            reason: "system-prefix-reordered",
            payloads: {
                consolidateSystemMessages: this.consolidateSystemMessages,
                systemMessageCountBefore: systemMessages.length,
                systemMessageCountAfter: reorderedSystemMessages.length,
                taggedSystemMessageCount: taggedSystemMessages.length,
            },
        };
    }
}
