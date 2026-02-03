
import { describe, it, expect } from 'vitest';
import { antigravityAdapter } from '../src/adapters/antigravity.js';
import type { RawJsonlEvent } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModelMessage(content: unknown[], usage: Record<string, number> | null = null): RawJsonlEvent {
  return {
    type: 'model',
    _sessionId: 'sess-ag-1',
    _agentId: null,
    timestamp: '2026-02-01T00:00:00Z',
    message: {
      content: content as RawJsonlEvent['message'] extends { content?: infer C } ? C : never,
      ...(usage && { usage }),
    },
  };
}

function makeToolResult(toolUseId: string, isError: boolean = false, content: string = 'result'): RawJsonlEvent {
  return {
    type: 'user',
    userType: 'tool_result',
    _sessionId: 'sess-ag-1',
    _agentId: null,
    timestamp: '2026-02-01T00:00:00Z',
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        is_error: isError,
        content,
      }],
    },
  };
}

function makeUserText(text: string): RawJsonlEvent {
  return {
    type: 'user',
    userType: 'external',
    _sessionId: 'sess-ag-1',
    _agentId: null,
    timestamp: '2026-02-01T00:00:00Z',
    message: { content: [{ type: 'text', text }] as RawJsonlEvent['message'] extends { content?: infer C } ? C : never },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Antigravity Adapter', () => {

  describe('Activity', () => {
    it('emits thinking', () => {
      const events = antigravityAdapter(makeModelMessage([{ type: 'thinking', thinking: 'planning...' }]));
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('activity');
      expect((events[0] as any).action).toBe('thinking');
      expect(events[0]!.sessionId).toBe('sess-ag-1');
    });

    it('does NOT leak thinking text', () => {
      const events = antigravityAdapter(makeModelMessage([{ type: 'thinking', thinking: 'secret plan' }]));
      expect(JSON.stringify(events[0])).not.toContain('secret plan');
    });

    it('emits responding', () => {
      const events = antigravityAdapter(makeModelMessage([{ type: 'text', text: 'Hello' }]));
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('activity');
      expect((events[0] as any).action).toBe('responding');
    });

    it('emits thinking for "(no content)" text block', () => {
      const events = antigravityAdapter(makeModelMessage([{ type: 'text', text: '(no content)' }]));
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('activity');
      expect((events[0] as any).action).toBe('thinking');
    });

    it('emits thinking for empty text block', () => {
      const events = antigravityAdapter(makeModelMessage([{ type: 'text', text: '   ' }]));
      expect(events).toHaveLength(1);
      expect((events[0] as any).action).toBe('thinking');
    });

    it('does NOT leak message text', () => {
      const events = antigravityAdapter(makeModelMessage([{ type: 'text', text: 'My secret API key is abc123' }]));
      expect(JSON.stringify(events)).not.toContain('secret');
      expect(JSON.stringify(events)).not.toContain('abc123');
    });

    it('includes token usage when present', () => {
      const usage = { input_tokens: 1000, output_tokens: 500 };
      const events = antigravityAdapter(makeModelMessage([{ type: 'text', text: 'hi' }], usage));
      expect((events[0] as any).tokens).toEqual({ input: 1000, output: 500 });
    });

    it('includes cache token fields', () => {
      const usage = {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 100,
      };
      const events = antigravityAdapter(makeModelMessage([{ type: 'text', text: 'hi' }], usage));
      expect((events[0] as any).tokens).toEqual({
        input: 1000,
        output: 500,
        cacheRead: 200,
        cacheWrite: 100,
      });
    });
  });

  describe('File Tools', () => {
    it('maps readFile to file_read with basename context', () => {
      const events = antigravityAdapter(makeModelMessage([{
        type: 'tool_use',
        id: 't1',
        name: 'readFile',
        input: { file_path: '/abs/path/to/script.ts' }
      }]));
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('tool');
      const e = events[0] as any;
      expect(e.tool).toBe('file_read');
      expect(e.detail).toBe('read');
      expect(e.context).toBe('script.ts');
      expect(JSON.stringify(events)).not.toContain('/abs/path');
    });

    it('maps readFile with TargetFile field', () => {
      const events = antigravityAdapter(makeModelMessage([{
        type: 'tool_use',
        id: 't1b',
        name: 'readFile',
        input: { TargetFile: '/src/app.js' }
      }]));
      const e = events[0] as any;
      expect(e.tool).toBe('file_read');
      expect(e.context).toBe('app.js');
    });

    it('maps writeFile to file_write with basename context', () => {
      const events = antigravityAdapter(makeModelMessage([{
        type: 'tool_use',
        id: 't2',
        name: 'writeFile',
        input: { target_file: '/src/main.rs', content: 'fn main() {}' }
      }]));
      const e = events[0] as any;
      expect(e.tool).toBe('file_write');
      expect(e.detail).toBe('write');
      expect(e.context).toBe('main.rs');
      expect(JSON.stringify(events)).not.toContain('fn main()');
    });

    it('maps editFile to file_write', () => {
      const events = antigravityAdapter(makeModelMessage([{
        type: 'tool_use',
        id: 't3',
        name: 'editFile',
        input: { file_path: '/a/b.ts', old_string: 'old', new_string: 'new' }
      }]));
      const e = events[0] as any;
      expect(e.tool).toBe('file_write');
      expect(e.detail).toBe('edit');
      expect(JSON.stringify(events)).not.toContain('old');
      expect(JSON.stringify(events)).not.toContain('new');
    });
  });

  describe('Terminal Tools', () => {
    it('maps runCommand to terminal with CommandLine context', () => {
      const events = antigravityAdapter(makeModelMessage([{
        type: 'tool_use',
        id: 't4',
        name: 'runCommand',
        input: { CommandLine: 'ls -la', Cwd: '/tmp' }
      }]));
      const e = events[0] as any;
      expect(e.tool).toBe('terminal');
      expect(e.detail).toBe('bash');
      expect(e.context).toBe('ls -la');
      expect(JSON.stringify(events)).not.toContain('/tmp');
    });

    it('maps runCommand with description field', () => {
      const events = antigravityAdapter(makeModelMessage([{
        type: 'tool_use',
        id: 't4b',
        name: 'runCommand',
        input: { command: 'npm test', description: 'Run tests' }
      }]));
      const e = events[0] as any;
      expect(e.tool).toBe('terminal');
      expect(e.context).toBe('Run tests');
      expect(JSON.stringify(events)).not.toContain('npm test');
    });

    it('runCommand with no description/CommandLine has no context', () => {
      const events = antigravityAdapter(makeModelMessage([{
        type: 'tool_use',
        id: 't4c',
        name: 'runCommand',
        input: { Cwd: '/tmp' }
      }]));
      expect(events[0]!).not.toHaveProperty('context');
    });
  });

  describe('Search Tools', () => {
    it('maps grepSearch to search with Query/pattern context', () => {
      const events = antigravityAdapter(makeModelMessage([{
        type: 'tool_use',
        id: 't5',
        name: 'grepSearch',
        input: { Query: 'FIXME', SearchPath: '/src' }
      }]));
      const e = events[0] as any;
      expect(e.tool).toBe('search');
      expect(e.detail).toBe('grep');
      expect(e.context).toBe('FIXME');
      expect(JSON.stringify(events)).not.toContain('/src');
    });

    it('maps globSearch to search with pattern context', () => {
      const events = antigravityAdapter(makeModelMessage([{
        type: 'tool_use',
        id: 't6',
        name: 'globSearch',
        input: { pattern: '**/*.ts' }
      }]));
      const e = events[0] as any;
      expect(e.tool).toBe('search');
      expect(e.detail).toBe('glob');
      expect(e.context).toBe('**/*.ts');
    });

    it('maps findByName to search', () => {
      const events = antigravityAdapter(makeModelMessage([{
        type: 'tool_use',
        id: 't7',
        name: 'findByName',
        input: { pattern: 'config.*' }
      }]));
      const e = events[0] as any;
      expect(e.tool).toBe('search');
      expect(e.detail).toBe('find');
    });

    it('maps readUrl to search with NO url context', () => {
      const events = antigravityAdapter(makeModelMessage([{
        type: 'tool_use',
        id: 't8',
        name: 'readUrl',
        input: { url: 'https://secret-api.com/token' }
      }]));
      const e = events[0] as any;
      expect(e.tool).toBe('search');
      expect(e.detail).toBe('web_fetch');
      expect(events[0]!).not.toHaveProperty('context');
      expect(JSON.stringify(events)).not.toContain('secret-api');
    });

    it('maps searchWeb to search with NO query context', () => {
      const events = antigravityAdapter(makeModelMessage([{
        type: 'tool_use',
        id: 't9',
        name: 'searchWeb',
        input: { query: 'how to hack NASA' }
      }]));
      const e = events[0] as any;
      expect(e.tool).toBe('search');
      expect(e.detail).toBe('web_search');
      expect(events[0]!).not.toHaveProperty('context');
      expect(JSON.stringify(events)).not.toContain('NASA');
    });
  });
  
  describe('Agent Spawning', () => {
    it('maps spawnAgent to spawn_agent AND emits agent event', () => {
      const events = antigravityAdapter(makeModelMessage([{
        type: 'tool_use',
        id: 't10',
        name: 'spawnAgent',
        input: { type: 'planner', prompt: 'Make a plan' }
      }]));
      
      expect(events).toHaveLength(2);
      
      // Tool event
      expect(events[0]!.type).toBe('tool');
      const e0 = events[0] as any;
      expect(e0.tool).toBe('spawn_agent');
      expect(e0.detail).toBe('task');
      expect(e0.context).toBe('planner');
      
      // Agent spawned event
      expect(events[1]!.type).toBe('agent');
      const e1 = events[1] as any;
      expect(e1.action).toBe('spawned');
      expect(e1.agentRole).toBe('planner');
      expect(e1.agentId).toBe('t10');
      expect(JSON.stringify(events)).not.toContain('Make a plan');
    });

    it('defaults agentRole to general when type missing', () => {
      const events = antigravityAdapter(makeModelMessage([{
        type: 'tool_use',
        id: 't11',
        name: 'spawnAgent',
        input: { prompt: 'do stuff' }
      }]));
      expect((events[1]! as { agentRole: string }).agentRole).toBe('general');
    });

    it('supports Task naming convention', () => {
      const events = antigravityAdapter(makeModelMessage([{
        type: 'tool_use',
        id: 't12',
        name: 'Task',
        input: { subagent_type: 'explore' }
      }]));
      expect(events).toHaveLength(2);
      expect((events[1]! as { agentRole: string }).agentRole).toBe('explore');
    });
  });

  describe('Communication', () => {
    it('emits waiting for askUser', () => {
      const events = antigravityAdapter(makeModelMessage([{
        type: 'tool_use',
        id: 't13',
        name: 'askUser',
        input: { question: 'What color?' }
      }]));
      expect(events.length).toBeGreaterThanOrEqual(1);
      const waitingEvent = events.find(e => (e as any).action === 'waiting');
      expect(waitingEvent).toBeDefined();
      expect(JSON.stringify(events)).not.toContain('What color');
    });
  });

  describe('Planning', () => {
    it('maps listTasks to plan with item count context', () => {
      const events = antigravityAdapter(makeModelMessage([{
        type: 'tool_use',
        id: 't14',
        name: 'listTasks',
        input: { todos: [{ content: 'a' }, { content: 'b' }, { content: 'c' }] }
      }]));
      const e = events[0] as any;
      expect(e.tool).toBe('plan');
      expect(e.detail).toBe('todo');
      expect(e.context).toBe('3 items');
      expect(JSON.stringify(events)).not.toContain('"a"');
    });
  });

  describe('Tool Results', () => {
    it('emits tool.completed for successful result', () => {
      const events = antigravityAdapter(makeToolResult('t1', false, 'file contents...'));
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('tool');
      const e = events[0] as any;
      expect(e.status).toBe('completed');
      expect(e.toolUseId).toBe('t1');
      expect(JSON.stringify(events)).not.toContain('file contents');
    });

    it('emits tool.error + error event for is_error=true', () => {
      const events = antigravityAdapter(makeToolResult('t2', true, 'Permission denied'));
      expect(events).toHaveLength(2);
      expect((events[0]! as { status: string }).status).toBe('error');
      expect(events[1]!.type).toBe('error');
      expect((events[1]! as { severity: string }).severity).toBe('warning');
    });

    it('detects errors from content containing "Error"', () => {
      const events = antigravityAdapter(makeToolResult('t3', false, 'Error: ENOENT: no such file'));
      expect((events[0]! as { status: string }).status).toBe('error');
      expect(events[1]!.type).toBe('error');
    });
  });

  describe('User Messages', () => {
    it('emits activity.user_prompt for user text', () => {
      const events = antigravityAdapter(makeUserText('Please fix the bug'));
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('activity');
      expect((events[0]! as { action: string }).action).toBe('user_prompt');
      expect(JSON.stringify(events)).not.toContain('fix the bug');
    });

    it('skips empty user text', () => {
      const events = antigravityAdapter(makeUserText('   '));
      expect(events).toHaveLength(0);
    });

    it('handles string content (terminal CLI format)', () => {
      const raw: RawJsonlEvent = {
        type: 'user',
        userType: 'external',
        _sessionId: 'sess-ag-1',
        _agentId: null,
        timestamp: '2026-02-01T00:00:00Z',
        message: { content: 'Please fix the bug in auth.ts' },
      };
      const events = antigravityAdapter(raw);
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('activity');
      expect((events[0]! as { action: string }).action).toBe('user_prompt');
      expect(JSON.stringify(events)).not.toContain('fix the bug');
      expect(JSON.stringify(events)).not.toContain('auth.ts');
    });

    it('skips empty string content', () => {
      const raw: RawJsonlEvent = {
        type: 'user',
        userType: 'external',
        _sessionId: 'sess-ag-1',
        _agentId: null,
        timestamp: '2026-02-01T00:00:00Z',
        message: { content: '   ' },
      };
      const events = antigravityAdapter(raw);
      expect(events).toHaveLength(0);
    });
  });

  describe('Summary', () => {
    it('emits summary event', () => {
      const events = antigravityAdapter({
        type: 'summary',
        _sessionId: 'sess-ag-1',
        _agentId: null,
        timestamp: '2026-02-01T00:00:00Z',
      });
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('summary');
      expect(events[0]!.sessionId).toBe('sess-ag-1');
    });
  });

  describe('Edge Cases', () => {
    it('returns empty for unknown raw.type', () => {
      const events = antigravityAdapter({
        type: 'file-history-snapshot', _sessionId: 'sess-ag-1', _agentId: null,
      });
      expect(events).toEqual([]);
    });

    it('returns empty for model with no content', () => {
      const events = antigravityAdapter({
        type: 'model', _sessionId: 'sess-ag-1', _agentId: null, message: {},
      });
      expect(events).toEqual([]);
    });

    it('returns empty for user with no content', () => {
      const events = antigravityAdapter({
        type: 'user', userType: 'tool_result', _sessionId: 'sess-ag-1', _agentId: null, message: {},
      });
      expect(events).toEqual([]);
    });

    it('handles multiple content blocks in one model message', () => {
      const events = antigravityAdapter(makeModelMessage([
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'Here is my answer' },
        { type: 'tool_use', id: 'toolu_x', name: 'readFile', input: { file_path: '/a/b.ts' } },
      ]));
      expect(events).toHaveLength(3);
      expect((events[0]! as { action: string }).action).toBe('thinking');
      expect((events[1]! as { action: string }).action).toBe('responding');
      expect(events[2]!.type).toBe('tool');
    });

    it('uses current timestamp when raw has no timestamp', () => {
      const raw = makeModelMessage([{ type: 'thinking', thinking: '' }]);
      delete raw.timestamp;
      const events = antigravityAdapter(raw);
      expect(events[0]!.timestamp).toBeDefined();
    });

    it('handles assistant type (in addition to model)', () => {
      const raw: RawJsonlEvent = {
        type: 'assistant',
        _sessionId: 'sess-ag-1',
        _agentId: null,
        timestamp: '2026-02-01T00:00:00Z',
        message: {
          content: [{ type: 'text', text: 'Hello' }],
        },
      };
      const events = antigravityAdapter(raw);
      expect(events).toHaveLength(1);
      expect((events[0]! as { action: string }).action).toBe('responding');
    });
  });

  describe('Agent Context', () => {
    it('includes agentId when raw has _agentId', () => {
      const raw = makeModelMessage([{ type: 'thinking', thinking: '' }]);
      raw._agentId = 'agent-abc';
      const events = antigravityAdapter(raw);
      expect((events[0]! as { agentId: string }).agentId).toBe('agent-abc');
    });

    it('omits agentId when _agentId is null', () => {
      const events = antigravityAdapter(makeModelMessage([{ type: 'thinking', thinking: '' }]));
      expect(events[0]!).not.toHaveProperty('agentId');
    });
  });

  describe('Privacy', () => {
    it('never includes full file paths', () => {
      const events = antigravityAdapter(makeModelMessage([
        { type: 'tool_use', id: 'p1', name: 'readFile', input: { file_path: '/Users/wayne/secret/passwords.txt' } },
        { type: 'tool_use', id: 'p2', name: 'writeFile', input: { target_file: '/home/user/.env', content: 'KEY=abc' } },
        { type: 'tool_use', id: 'p3', name: 'editFile', input: { file_path: '/var/log/auth.log', old_string: 'x', new_string: 'y' } },
      ]));
      const json = JSON.stringify(events);
      expect(json).not.toContain('/Users/wayne');
      expect(json).not.toContain('/home/user');
      expect(json).not.toContain('/var/log');
      expect(json).toContain('passwords.txt');
      expect(json).toContain('.env');
      expect(json).toContain('auth.log');
    });

    it('never includes bash commands', () => {
      const events = antigravityAdapter(makeModelMessage([{
        type: 'tool_use', id: 'p4', name: 'runCommand',
        input: { CommandLine: 'cat /etc/passwd | grep root', description: 'Check system users' },
      }]));
      const json = JSON.stringify(events);
      expect(json).not.toContain('cat /etc/passwd');
      expect(json).not.toContain('grep root');
      expect(json).toContain('Check system users');
    });

    it('never includes URLs or search queries', () => {
      const events = antigravityAdapter(makeModelMessage([
        { type: 'tool_use', id: 'p5', name: 'readUrl', input: { url: 'https://internal.corp.com/api', prompt: 'extract key' } },
        { type: 'tool_use', id: 'p6', name: 'searchWeb', input: { query: 'social security number lookup' } },
      ]));
      const json = JSON.stringify(events);
      expect(json).not.toContain('internal.corp.com');
      expect(json).not.toContain('social security');
      expect(json).not.toContain('extract key');
    });

    it('never includes task prompts', () => {
      const events = antigravityAdapter(makeModelMessage([{
        type: 'tool_use', id: 'p7', name: 'spawnAgent',
        input: { type: 'bash', prompt: 'Find all SSH keys and private credentials', description: 'Security audit' },
      }]));
      const json = JSON.stringify(events);
      expect(json).not.toContain('SSH keys');
      expect(json).not.toContain('private credentials');
      expect(json).not.toContain('Security audit');
    });

    it('never includes todo content', () => {
      const events = antigravityAdapter(makeModelMessage([{
        type: 'tool_use', id: 'p8', name: 'listTasks',
        input: { todos: [{ content: 'Delete production database', status: 'pending' }] },
      }]));
      const json = JSON.stringify(events);
      expect(json).not.toContain('Delete production');
    });

    it('never includes file content from writeFile', () => {
      const events = antigravityAdapter(makeModelMessage([{
        type: 'tool_use', id: 'p9', name: 'writeFile',
        input: { file_path: '/a/config.json', content: '{"apiKey":"sk-secret-123"}' },
      }]));
      const json = JSON.stringify(events);
      expect(json).not.toContain('sk-secret');
      expect(json).not.toContain('apiKey');
    });

    it('never includes edit strings from editFile', () => {
      const events = antigravityAdapter(makeModelMessage([{
        type: 'tool_use', id: 'p10', name: 'editFile',
        input: { file_path: '/a/b.js', old_string: 'const password = "hunter2"', new_string: 'const password = process.env.PW' },
      }]));
      const json = JSON.stringify(events);
      expect(json).not.toContain('hunter2');
      expect(json).not.toContain('process.env.PW');
    });

    it('never includes tool result content', () => {
      const events = antigravityAdapter(makeToolResult('p11', false, 'File contents:\nSECRET_KEY=abc123\nDB_PASSWORD=hunter2'));
      const json = JSON.stringify(events);
      expect(json).not.toContain('SECRET_KEY');
      expect(json).not.toContain('hunter2');
    });
  });
});
