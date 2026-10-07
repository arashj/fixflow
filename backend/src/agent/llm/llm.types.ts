import type { ToolSpec } from '../tools';

// Mirrors the Anthropic Messages API content blocks we use.
export type TextBlock = { type: 'text'; text: string };
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
export type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/webp'; data: string } };
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock | { type: string; [k: string]: unknown };

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: ToolSpec[];
  maxTokens?: number;
}

export interface LlmResponse {
  content: ContentBlock[];
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

export interface LlmClient {
  /** 'claude' calls the Anthropic API; 'local' is the built-in rules engine used when no API key is configured. */
  readonly mode: 'claude' | 'local';
  readonly model: string;
  createMessage(req: LlmRequest): Promise<LlmResponse>;
}

export const LLM_CLIENT = Symbol('LLM_CLIENT');

/** Errors that should not be retried (bad request, auth). Anything else is retried with backoff. */
export class NonRetryableError extends Error {}
