import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  toolLoop,
  __setChatTransportForTests,
  configureGateway,
  resetGateway,
  type ChatBlock,
  type ChatMessage,
  type ToolHandler,
  __providerSpecificChatOptionsForTests,
  __normalizeMessagesForPromptForTests,
} from '../../src/core/ai/gateway.ts';

describe('gateway.toolLoop (v0.38 D11 — provider-agnostic loop control)', () => {
  beforeEach(() => {
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      expansion_model: 'anthropic:claude-haiku-4-5',
      env: { ANTHROPIC_API_KEY: 'stub', OPENAI_API_KEY: 'stub' },
    });
  });
  afterEach(() => {
    __setChatTransportForTests(null);
    resetGateway();
  });

  it('exits cleanly on end stop_reason with no tools', async () => {
    __setChatTransportForTests(async () => ({
      text: 'hello world',
      blocks: [{ type: 'text', text: 'hello world' }] as ChatBlock[],
      stopReason: 'end',
      usage: { input_tokens: 5, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    }));

    const result = await toolLoop({
      initialMessages: [{ role: 'user', content: 'hi' }],
      tools: [],
      toolHandlers: new Map(),
    });

    expect(result.stopReason).toBe('end');
    expect(result.finalText).toBe('hello world');
    expect(result.totalTurns).toBe(0); // First turn ended cleanly without tool dispatch
    expect(result.totalUsage.input_tokens).toBe(5);
  });

  it('dispatches a single tool call and feeds the result back to the next turn', async () => {
    let turn = 0;
    __setChatTransportForTests(async () => {
      turn++;
      if (turn === 1) {
        return {
          text: '',
          blocks: [
            { type: 'tool-call', toolCallId: 'tc1', toolName: 'search', input: { q: 'foo' } },
          ] as ChatBlock[],
          stopReason: 'tool_calls',
          usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-sonnet-4-6',
          providerId: 'anthropic',
        };
      }
      return {
        text: 'final answer',
        blocks: [{ type: 'text', text: 'final answer' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 15, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      };
    });

    let toolWasCalled = false;
    const handler: ToolHandler = {
      idempotent: true,
      async execute(input) {
        toolWasCalled = true;
        expect(input).toEqual({ q: 'foo' });
        return { ok: true, results: [{ slug: 'foo/bar' }] };
      },
    };

    const result = await toolLoop({
      initialMessages: [{ role: 'user', content: 'find foo' }],
      tools: [{ name: 'search', description: 'search the brain', inputSchema: { type: 'object' } }],
      toolHandlers: new Map([['search', handler]]),
    });

    expect(toolWasCalled).toBe(true);
    expect(result.stopReason).toBe('end');
    expect(result.finalText).toBe('final answer');
    expect(result.totalUsage.input_tokens).toBe(25); // 10 + 15
    expect(result.totalUsage.output_tokens).toBe(9); // 4 + 5
  });

  it('captures persistence callbacks in order: assistant → tool start → tool complete', async () => {
    let turn = 0;
    __setChatTransportForTests(async () => {
      turn++;
      if (turn === 1) {
        return {
          text: '',
          blocks: [
            { type: 'tool-call', toolCallId: 'tc1', toolName: 'echo', input: { msg: 'hi' } },
          ] as ChatBlock[],
          stopReason: 'tool_calls',
          usage: { input_tokens: 5, output_tokens: 3, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-sonnet-4-6',
          providerId: 'anthropic',
        };
      }
      return {
        text: 'done',
        blocks: [{ type: 'text', text: 'done' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 5, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      };
    });

    const events: string[] = [];

    await toolLoop({
      initialMessages: [{ role: 'user', content: 'echo hi' }],
      tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }],
      toolHandlers: new Map([['echo', {
        idempotent: true,
        async execute(input) { events.push(`execute(${JSON.stringify(input)})`); return input; },
      }]]),
      onAssistantTurn: async (turnIdx, _msgIdx, _blocks, _usage, _model) => {
        events.push(`onAssistantTurn(${turnIdx})`);
      },
      onToolCallStart: async (turnIdx, _msgIdx, ordinal, toolName, _input, providerToolCallId) => {
        events.push(`onToolCallStart(turn=${turnIdx}, ordinal=${ordinal}, name=${toolName}, providerCallId=${providerToolCallId})`);
        return { gbrainToolUseId: `gb-${turnIdx}-${ordinal}` };
      },
      onToolCallComplete: async (gbrainToolUseId, _output) => {
        events.push(`onToolCallComplete(${gbrainToolUseId})`);
      },
      onToolResultsTurn: async (turnIdx, _msgIdx, blocks) => {
        events.push(`onToolResultsTurn(${turnIdx}, ${blocks.length})`);
      },
    });

    // Write-ordering invariant: assistant persisted BEFORE pending tool row;
    // pending row persisted BEFORE execute; execute BEFORE complete.
    expect(events[0]).toBe('onAssistantTurn(0)');
    expect(events[1]).toMatch(/onToolCallStart\(turn=0, ordinal=0, name=echo/);
    expect(events[2]).toMatch(/execute/);
    expect(events[3]).toMatch(/onToolCallComplete\(gb-0-0\)/);
    expect(events[4]).toBe('onToolResultsTurn(0, 1)');
    expect(events[5]).toBe('onAssistantTurn(1)'); // final assistant turn
  });

  it('replay short-circuits a complete prior tool execution', async () => {
    let chatCalls = 0;
    __setChatTransportForTests(async () => {
      chatCalls++;
      // Turn 1 emits a tool call. Turn 2 finishes.
      if (chatCalls === 1) {
        return {
          text: '',
          blocks: [
            { type: 'tool-call', toolCallId: 'provider-id-1', toolName: 'work', input: { x: 1 } },
          ] as ChatBlock[],
          stopReason: 'tool_calls',
          usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-sonnet-4-6',
          providerId: 'anthropic',
        };
      }
      return {
        text: 'fin',
        blocks: [{ type: 'text', text: 'fin' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      };
    });

    let executed = false;
    const result = await toolLoop({
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'work', description: 'w', inputSchema: { type: 'object' } }],
      toolHandlers: new Map([['work', {
        idempotent: false,
        async execute() { executed = true; return 'fresh'; },
      }]]),
      onToolCallStart: async () => ({ gbrainToolUseId: 'gb-replay-key' }),
      replayState: {
        priorMessages: [],
        priorTools: new Map([['gb-replay-key', {
          status: 'complete' as const,
          output: 'from-prior-run',
        }]]),
        nextTurnIdx: 0,
        nextMessageIdx: 0,
      },
    });

    expect(executed).toBe(false); // replay short-circuit
    expect(result.stopReason).toBe('end');
    expect(result.finalText).toBe('fin');
  });

  it('refuses replay of non-idempotent pending tool with unrecoverable error', async () => {
    __setChatTransportForTests(async () => ({
      text: '',
      blocks: [
        { type: 'tool-call', toolCallId: 'tc-non-idem', toolName: 'mutate', input: {} },
      ] as ChatBlock[],
      stopReason: 'tool_calls',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    }));

    await expect(
      toolLoop({
        initialMessages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'mutate', description: 'm', inputSchema: { type: 'object' } }],
        toolHandlers: new Map([['mutate', { idempotent: false, async execute() { return null; } }]]),
        onToolCallStart: async () => ({ gbrainToolUseId: 'gb-pending-key' }),
        replayState: {
          priorMessages: [],
          priorTools: new Map([['gb-pending-key', { status: 'pending' as const }]]),
          nextTurnIdx: 0,
          nextMessageIdx: 0,
        },
      }),
    ).rejects.toThrow(/non-idempotent.*pending/i);
  });

  it('hits max_turns when the model keeps calling tools', async () => {
    __setChatTransportForTests(async () => ({
      text: '',
      blocks: [
        { type: 'tool-call', toolCallId: `tc-${Math.random()}`, toolName: 'loop', input: {} },
      ] as ChatBlock[],
      stopReason: 'tool_calls',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    }));

    const result = await toolLoop({
      initialMessages: [{ role: 'user', content: 'loop' }],
      tools: [{ name: 'loop', description: 'l', inputSchema: { type: 'object' } }],
      toolHandlers: new Map([['loop', { idempotent: true, async execute() { return null; } }]]),
      maxTurns: 3,
    });

    expect(result.stopReason).toBe('max_turns');
    expect(result.totalTurns).toBeGreaterThanOrEqual(3);
  });

  it('returns refusal reason without dispatching tools when stopReason=refusal', async () => {
    __setChatTransportForTests(async () => ({
      text: 'I cannot help with that',
      blocks: [{ type: 'text', text: 'I cannot help with that' }] as ChatBlock[],
      stopReason: 'refusal',
      usage: { input_tokens: 1, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    }));

    let toolWasCalled = false;
    const result = await toolLoop({
      initialMessages: [{ role: 'user', content: 'bad request' }],
      tools: [{ name: 'work', description: 'w', inputSchema: { type: 'object' } }],
      toolHandlers: new Map([['work', { idempotent: true, async execute() { toolWasCalled = true; return null; } }]]),
    });

    expect(toolWasCalled).toBe(false);
    expect(result.stopReason).toBe('refusal');
    expect(result.finalText).toBe('I cannot help with that');
  });

  it('normalizes provider-neutral tool results before replaying them as model messages', () => {
    const normalized = __normalizeMessagesForPromptForTests([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-deepseek-json-safe',
            toolName: 'lookup',
            input: { q: 'nested undefineds' },
            output: { ok: true, nested: { missing: undefined }, list: [1, undefined] },
            isError: false,
          } as any,
          {
            type: 'tool-result',
            toolCallId: 'call-deepseek-error',
            toolName: 'lookup',
            input: { q: 'boom' },
            output: 'upstream timeout',
            isError: true,
          } as any,
          {
            type: 'tool-result',
            toolCallId: 'call-deepseek-weird',
            toolName: 'lookup',
            output: { fn: () => 'nope', big: 12n, symbol: Symbol('x') },
          } as any,
        ],
      },
    ]);

    expect(normalized).toEqual([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-deepseek-json-safe',
            toolName: 'lookup',
            output: { type: 'json', value: { ok: true, nested: { missing: null }, list: [1, null] } },
          },
          {
            type: 'tool-result',
            toolCallId: 'call-deepseek-error',
            toolName: 'lookup',
            output: { type: 'json', value: { error: 'upstream timeout' } },
          },
          {
            type: 'tool-result',
            toolCallId: 'call-deepseek-weird',
            toolName: 'lookup',
            output: { type: 'json', value: { fn: '() => "nope"', big: '12', symbol: 'Symbol(x)' } },
          },
        ],
      },
    ]);
  });

  it('continues a multi-tool turn when one tool errors and preserves one result per provider call', async () => {
    let chatCalls = 0;
    __setChatTransportForTests(async () => {
      chatCalls++;
      if (chatCalls === 1) {
        return {
          text: '',
          blocks: [
            { type: 'tool-call', toolCallId: 'tc-ok', toolName: 'ok', input: { n: 1 } },
            { type: 'tool-call', toolCallId: 'tc-bad', toolName: 'bad', input: { n: 2 } },
            { type: 'tool-call', toolCallId: 'tc-missing', toolName: 'missing', input: { n: 3 } },
          ] as ChatBlock[],
          stopReason: 'tool_calls',
          usage: { input_tokens: 3, output_tokens: 3, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'deepseek:deepseek-v4-flash',
          providerId: 'deepseek',
        };
      }
      return {
        text: 'handled mixed tool results',
        blocks: [{ type: 'text', text: 'handled mixed tool results' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 4, output_tokens: 4, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'deepseek:deepseek-v4-flash',
        providerId: 'deepseek',
      };
    });

    const persistedTurns: ChatBlock[][] = [];
    const failed: string[] = [];
    const result = await toolLoop({
      initialMessages: [{ role: 'user', content: 'run all tools' }],
      tools: [
        { name: 'ok', description: 'ok', inputSchema: { type: 'object' } },
        { name: 'bad', description: 'bad', inputSchema: { type: 'object' } },
      ],
      toolHandlers: new Map([
        ['ok', { idempotent: true, async execute() { return { ok: true }; } }],
        ['bad', { idempotent: true, async execute() { throw new Error('adversarial failure'); } }],
      ]),
      onToolCallFailed: async (gbrainToolUseId, error) => {
        failed.push(`${gbrainToolUseId}:${error}`);
      },
      onToolResultsTurn: async (_turnIdx, _msgIdx, blocks) => {
        persistedTurns.push(blocks);
      },
    });

    expect(result.stopReason).toBe('end');
    expect(result.finalText).toBe('handled mixed tool results');
    expect(persistedTurns).toHaveLength(1);
    const firstTurn = persistedTurns[0].filter((b): b is Extract<ChatBlock, { type: 'tool-result' }> => b.type === 'tool-result');
    expect(firstTurn.map(b => b.toolCallId)).toEqual(['tc-ok', 'tc-bad', 'tc-missing']);
    expect(firstTurn.map(b => b.isError === true)).toEqual([false, true, true]);
    expect(failed).toEqual(['inline-0-1:adversarial failure']);
  });

  it('is cycle-safe when tool outputs contain circular objects or exotic values', () => {
    const circular: any = { name: 'root', nested: { bad: undefined }, big: 12n, fn: () => 'x', sym: Symbol('s') };
    circular.self = circular;
    circular.items = [circular];

    const normalized = __normalizeMessagesForPromptForTests([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tc-cycle',
            toolName: 'cycle_tool',
            output: { type: 'json', value: circular },
            input: circular,
          } as any,
        ],
      },
    ]);

    const block = (normalized[0].content as ChatBlock[])[0] as Extract<ChatBlock, { type: 'tool-result' }>;
    expect(block).toEqual({
      type: 'tool-result',
      toolCallId: 'tc-cycle',
      toolName: 'cycle_tool',
      output: {
        type: 'json',
        value: {
          name: 'root',
          nested: { bad: null },
          big: '12',
          fn: '() => "x"',
          sym: 'Symbol(s)',
          self: '[Circular]',
          items: ['[Circular]'],
        },
      },
    });
  });

  it('survives large malformed-input tool calls without corrupting the next replay turn', async () => {
    let callCount = 0;
    let secondTurnMessages: ChatMessage[] | null = null;
    const giantInput = 'x'.repeat(64_000);
    __setChatTransportForTests(async ({ messages }) => {
      callCount += 1;
      if (callCount === 2) secondTurnMessages = messages;
      if (callCount === 1) {
        return {
          text: '',
          blocks: [
            { type: 'tool-call', toolCallId: 'tc-weird', toolName: 'weird', input: giantInput },
          ] as ChatBlock[],
          stopReason: 'tool_calls',
          usage: { input_tokens: 3, output_tokens: 3, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'deepseek:deepseek-v4-flash',
          providerId: 'deepseek',
        };
      }
      return {
        text: 'ok after weird input',
        blocks: [{ type: 'text', text: 'ok after weird input' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 4, output_tokens: 4, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'deepseek:deepseek-v4-flash',
        providerId: 'deepseek',
      };
    });

    const result = await toolLoop({
      initialMessages: [{ role: 'user', content: 'call malformed tool input' }],
      tools: [{ name: 'weird', description: 'weird', inputSchema: { type: 'object' } }],
      toolHandlers: new Map([['weird', {
        idempotent: true,
        async execute(input) {
          return { inputType: typeof input, inputLength: String(input).length };
        },
      }]]),
      model: 'deepseek:deepseek-v4-flash',
    });

    expect(result.finalText).toBe('ok after weird input');
    expect(secondTurnMessages).not.toBeNull();
    const toolMsg = secondTurnMessages!.find(m => m.role === 'tool')!;
    const block = (toolMsg.content as ChatBlock[])[0] as Extract<ChatBlock, { type: 'tool-result' }>;
    expect(block.output).toEqual({ inputType: 'string', inputLength: 64000 });
  });

  it('disables DeepSeek V4 thinking mode for provider-neutral tool-loop compatibility', () => {
    expect(__providerSpecificChatOptionsForTests('deepseek', 'deepseek-v4-flash')).toEqual({
      thinking: { type: 'disabled' },
    });
    expect(__providerSpecificChatOptionsForTests('deepseek', 'deepseek-v4-pro')).toEqual({
      thinking: { type: 'disabled' },
    });
    expect(__providerSpecificChatOptionsForTests('deepseek', 'deepseek-chat')).toEqual({});
    expect(__providerSpecificChatOptionsForTests('google', 'gemini-2.5-flash')).toEqual({});
    expect(__providerSpecificChatOptionsForTests('google', 'gemini-2.5-pro')).toEqual({});
    expect(__providerSpecificChatOptionsForTests('anthropic', 'claude-sonnet-4-6')).toEqual({});
  });
});
