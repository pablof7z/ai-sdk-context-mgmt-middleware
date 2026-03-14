import { clonePrompt, isContextManagementSystemMessage } from "./prompt-utils.js";
import type {
  ContextManagementStrategy,
  ContextManagementStrategyExecution,
  ContextManagementStrategyState,
  SystemPromptCachingStrategyOptions,
} from "./types.js";

export class SystemPromptCachingStrategy implements ContextManagementStrategy {
  readonly name = "system-prompt-caching";
  private readonly consolidateSystemMessages: boolean;

  constructor(options: SystemPromptCachingStrategyOptions = {}) {
    this.consolidateSystemMessages = options.consolidateSystemMessages ?? true;
  }

  apply(state: ContextManagementStrategyState): ContextManagementStrategyExecution {
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
        { role: "system" as const, content: consolidatedContent },
        ...taggedSystemMessages,
      ];
    } else {
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
