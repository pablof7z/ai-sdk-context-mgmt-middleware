import { trimPromptHeadAndTail } from "./prompt-utils.js";
const DEFAULT_HEAD_COUNT = 2;
const DEFAULT_TAIL_COUNT = 8;
const REASON = "head-and-tail";
export class HeadAndTailStrategy {
    name = "head-and-tail";
    headCount;
    tailCount;
    constructor(options = {}) {
        this.headCount = Math.max(0, Math.floor(options.headCount ?? DEFAULT_HEAD_COUNT));
        this.tailCount = Math.max(0, Math.floor(options.tailCount ?? DEFAULT_TAIL_COUNT));
    }
    apply(state) {
        const result = trimPromptHeadAndTail(state.prompt, this.headCount, this.tailCount, REASON, { pinnedToolCallIds: state.pinnedToolCallIds });
        const trimmed = result.prompt.length < state.prompt.length;
        if (!trimmed) {
            const nonSystemCount = state.prompt.reduce((count, msg) => count + (msg.role === "system" ? 0 : 1), 0);
            const withinWindow = nonSystemCount <= this.headCount + this.tailCount;
            return {
                reason: withinWindow ? "within-head-tail-window" : "head-tail-overlap",
                payloads: {
                    headCount: this.headCount,
                    tailCount: this.tailCount,
                    messagesDropped: 0,
                },
            };
        }
        const messagesDropped = state.prompt.length - result.prompt.length;
        state.updatePrompt(result.prompt);
        state.addRemovedToolExchanges(result.removedToolExchanges);
        return {
            reason: "middle-trimmed",
            payloads: {
                headCount: this.headCount,
                tailCount: this.tailCount,
                messagesDropped,
            },
        };
    }
}
