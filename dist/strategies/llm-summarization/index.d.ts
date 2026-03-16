import type { LanguageModelV3Message } from "@ai-sdk/provider";
import type { LlmSummarizerFormattingOptions, LlmSummarizerOptions } from "../../types.js";
export declare function buildSummaryTranscript(messages: LanguageModelV3Message[], formatting?: LlmSummarizerFormattingOptions): string;
export declare function buildDeterministicSummary(messages: LanguageModelV3Message[], formatting?: LlmSummarizerFormattingOptions): string;
export declare function createLlmSummarizer(options: LlmSummarizerOptions): (messages: LanguageModelV3Message[]) => Promise<string>;
