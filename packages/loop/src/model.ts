/**
 * Model access (docs/onus-loop-v0.md §10): one interface, `generate(context)
 * → text`, behind which sit a scripted model for the tests, the Anthropic
 * API, OpenRouter (the OpenAI chat-completions protocol, any model it
 * routes), and Claude Code as a subprocess. Keys come from the environment
 * (`.env.local` is read by the CLI), never from the command line.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** A provider that has not answered in this long is not going to; the loop reports the model as failed (§9). */
export const REQUEST_TIMEOUT_MS = 180000;

export interface GenerateRequest {
  readonly system: string;
  readonly prompt: string;
  readonly maxTokens: number;
}

export interface GenerateResult {
  readonly text: string;
  /** The model that answered, for the trace. */
  readonly model: string;
  /** Tokens consumed (input and output), against the task budget. */
  readonly tokens: number;
}

export interface Model {
  readonly name: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

/** Answers from a fixed list, repeating the last; records every request. */
export class ScriptedModel implements Model {
  readonly name = 'scripted';
  readonly requests: GenerateRequest[] = [];
  private index = 0;

  constructor(private readonly responses: readonly string[]) {}

  generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    const text = this.responses[Math.min(this.index, this.responses.length - 1)] ?? '';
    this.index += 1;
    return Promise.resolve({ text, model: this.name, tokens: Math.ceil((req.system.length + req.prompt.length + text.length) / 4) });
  }
}

/** Claude Code as a subprocess: `claude -p`, the prompt on stdin. */
export class ClaudeCodeModel implements Model {
  readonly name: string;

  constructor(private readonly modelId: string | null = null) {
    this.name = modelId === null ? 'claude-code' : `claude-code:${modelId}`;
  }

  generate(req: GenerateRequest): Promise<GenerateResult> {
    // A nested Claude Code refuses to start inside another; the marker variables are not inherited.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('CLAUDE')) env[k] = v;
    const args = ['-p', '--output-format', 'text', '--system-prompt', req.system, ...(this.modelId === null ? [] : ['--model', this.modelId])];
    const r = spawnSync('claude', args, { input: req.prompt, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
    if (r.error !== undefined) return Promise.reject(new Error(`claude: ${r.error.message}`));
    if (r.status !== 0) return Promise.reject(new Error(`claude exited ${r.status}: ${r.stderr}`));
    return Promise.resolve({ text: r.stdout, model: this.name, tokens: Math.ceil((req.system.length + req.prompt.length + r.stdout.length) / 4) });
  }
}

/** The Anthropic Messages API over `fetch`; the key comes from `ANTHROPIC_API_KEY`. */
export class AnthropicModel implements Model {
  readonly name: string;

  constructor(
    private readonly apiKey: string,
    private readonly modelId = 'claude-fable-5-1',
  ) {
    this.name = `anthropic:${modelId}`;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: this.modelId, max_tokens: req.maxTokens, system: req.system, messages: [{ role: 'user', content: req.prompt }] }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`anthropic: HTTP ${res.status}: ${await res.text()}`);
    const body: unknown = await res.json();
    const text = contentText(body);
    const usage = typeof body === 'object' && body !== null && 'usage' in body ? body.usage : null;
    const tokens = typeof usage === 'object' && usage !== null && 'input_tokens' in usage && 'output_tokens' in usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number' ? usage.input_tokens + usage.output_tokens : Math.ceil(text.length / 4);
    return { text, model: this.name, tokens };
  }
}

/** OpenRouter's chat-completions endpoint; the key comes from `OPENROUTER_API_KEY`, the default model from `OPENROUTER_MODEL`. */
export class OpenRouterModel implements Model {
  readonly name: string;

  constructor(
    private readonly apiKey: string,
    private readonly modelId: string,
  ) {
    this.name = `openrouter:${modelId}`;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}`, 'x-title': 'onus loop' },
      body: JSON.stringify({ model: this.modelId, max_tokens: req.maxTokens, messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.prompt }] }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`openrouter: HTTP ${res.status}: ${await res.text()}`);
    const body: unknown = await res.json();
    const text = choiceText(body);
    const usage = typeof body === 'object' && body !== null && 'usage' in body ? body.usage : null;
    const tokens = typeof usage === 'object' && usage !== null && 'total_tokens' in usage && typeof usage.total_tokens === 'number' ? usage.total_tokens : Math.ceil((req.system.length + req.prompt.length + text.length) / 4);
    return { text, model: this.name, tokens };
  }
}

function choiceText(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  if ('error' in body && typeof body.error === 'object' && body.error !== null && 'message' in body.error) throw new Error(`openrouter: ${String(body.error.message)}`);
  if (!('choices' in body) || !Array.isArray(body.choices)) return '';
  const first: unknown = body.choices[0];
  if (typeof first !== 'object' || first === null || !('message' in first) || typeof first.message !== 'object' || first.message === null || !('content' in first.message)) return '';
  const content: unknown = first.message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part: unknown) => (typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string' ? part.text : '')).join('');
}

function contentText(body: unknown): string {
  if (typeof body !== 'object' || body === null || !('content' in body) || !Array.isArray(body.content)) return '';
  const parts: string[] = [];
  for (const block of body.content) {
    if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('');
}

/**
 * A model from a command-line spec: `claude-code[:<model>]`,
 * `anthropic[:<model>]`, or `scripted:<file.json>` (a JSON array of
 * answers). Returns the model or a message. Effects: reads the scripted file.
 */
export function modelFromSpec(spec: string): Model | string {
  const [head, ...rest] = spec.split(':');
  const arg = rest.length === 0 ? null : rest.join(':');
  switch (head) {
    case 'claude-code':
      return new ClaudeCodeModel(arg);
    case 'anthropic': {
      const key = process.env['ANTHROPIC_API_KEY'];
      if (key === undefined || key === '') return 'the anthropic model needs ANTHROPIC_API_KEY';
      return arg === null ? new AnthropicModel(key) : new AnthropicModel(key, arg);
    }
    case 'openrouter': {
      const key = process.env['OPENROUTER_API_KEY'];
      if (key === undefined || key === '') return 'the openrouter model needs OPENROUTER_API_KEY (in the environment or a .env.local at the project root)';
      const model = arg ?? process.env['OPENROUTER_MODEL'] ?? 'deepseek/deepseek-v4-flash';
      return new OpenRouterModel(key, model);
    }
    case 'scripted': {
      if (arg === null) return 'scripted:<file.json> names a JSON array of answers';
      const parsed: unknown = JSON.parse(readFileSync(arg, 'utf8'));
      if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) return `${arg}: not a JSON array of strings`;
      return new ScriptedModel(parsed);
    }
    default:
      return `unknown model spec ${spec}; use claude-code[:<model>], anthropic[:<model>], openrouter[:<model>] or scripted:<file.json>`;
  }
}
