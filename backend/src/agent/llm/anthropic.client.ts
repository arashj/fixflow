import Anthropic from '@anthropic-ai/sdk';
import { LlmClient, LlmRequest, LlmResponse, NonRetryableError } from './llm.types';

export class AnthropicLlmClient implements LlmClient {
  readonly mode = 'claude' as const;
  private client: Anthropic;

  constructor(apiKey: string, readonly model: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  }

  async createMessage(req: LlmRequest): Promise<LlmResponse> {
    try {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: req.maxTokens ?? 2048,
        system: req.system,
        messages: req.messages as Anthropic.MessageParam[],
        tools: req.tools as Anthropic.Tool[],
      });
      return {
        content: res.content as unknown as LlmResponse['content'],
        stopReason: res.stop_reason,
        usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
        model: res.model,
      };
    } catch (e) {
      if (e instanceof Anthropic.APIError && e.status !== undefined && [400, 401, 403, 404, 422].includes(e.status)) {
        throw new NonRetryableError(`Claude API ${e.status}: ${e.message}`);
      }
      throw e;
    }
  }
}
