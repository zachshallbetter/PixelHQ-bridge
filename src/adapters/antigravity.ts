
import {
  createActivityEvent,
  createToolEvent,
  createAgentEvent,
  createErrorEvent,
  createSummaryEvent,
  toBasename,
} from '../pixel-events.js';
import { ToolCategory } from '../config.js';
import type { PixelEvent, RawJsonlEvent, RawUsage, TokenUsage } from '../types.js';

// Antigravity Tool Mapping
const ANTIGRAVITY_TOOL_MAP: Record<string, { category: string; detail: string }> = {
  // File operations
  readFile:      { category: ToolCategory.FILE_READ,    detail: 'read' },
  writeFile:     { category: ToolCategory.FILE_WRITE,   detail: 'write' },
  editFile:      { category: ToolCategory.FILE_WRITE,   detail: 'edit' },
  
  // Terminal
  runCommand:    { category: ToolCategory.TERMINAL,     detail: 'bash' },
  
  // Search
  grepSearch:    { category: ToolCategory.SEARCH,       detail: 'grep' },
  globSearch:    { category: ToolCategory.SEARCH,       detail: 'glob' },
  findByName:    { category: ToolCategory.SEARCH,       detail: 'find' },
  
  // Web
  searchWeb:     { category: ToolCategory.SEARCH,       detail: 'web_search' },
  readUrl:       { category: ToolCategory.SEARCH,       detail: 'web_fetch' },

  // Agent/Planning
  spawnAgent:    { category: ToolCategory.SPAWN_AGENT,  detail: 'task' },
  listTasks:     { category: ToolCategory.PLAN,         detail: 'todo' },
  
  // Communication
  askUser:       { category: ToolCategory.COMMUNICATE,  detail: 'ask_user' },
};

/**
 * Transform a raw Antigravity JSONL object into PixelEvent(s).
 * Assumes a schema similar to:
 * {
 *   "type": "model" | "user" | "tool",
 *   "content": "...",
 *   "tool_calls": [...],
 *   "usage": { ... }
 * }
 */
export function antigravityAdapter(raw: RawJsonlEvent): PixelEvent[] {
  const sessionId = raw._sessionId;
  const agentId = raw._agentId || null;
  const timestamp = raw.timestamp || new Date().toISOString();

  // Basic routing based on top-level type
  switch (raw.type) {
    case 'assistant':
    case 'model': 
      return handleModel(raw, sessionId, agentId, timestamp);

    case 'user':
      return handleUser(raw, sessionId, agentId, timestamp);

    case 'summary':
      return [createSummaryEvent(sessionId, timestamp)];

    default:
      return [];
  }
}

function handleModel(
  raw: RawJsonlEvent,
  sessionId: string,
  agentId: string | null,
  timestamp: string,
): PixelEvent[] {
  const events: PixelEvent[] = [];
  const message = raw.message;
  
  // If undefined message, skip
  if (!message) return events;

  // 1. Handle Thinking / Content
  const content = message.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'thinking') {
        events.push(createActivityEvent(sessionId, agentId, timestamp, 'thinking'));
      } else if (block.type === 'text') {
        // Handle empty or "(no content)" text blocks
        if (block.text === '(no content)' || !block.text?.trim()) {
          events.push(createActivityEvent(sessionId, agentId, timestamp, 'thinking'));
        } else {
          // Only emit responding if there is actual text
          events.push(createActivityEvent(sessionId, agentId, timestamp, 'responding', extractTokens(message.usage || null)));
        }
      } else if (block.type === 'tool_use') {
        events.push(buildToolStartedEvent(sessionId, agentId, timestamp, block));
        
        // Spawn special handling
        if (block.name === 'spawnAgent' || block.name === 'Task') {
          events.push(
            createAgentEvent(
              sessionId,
              block.id,
              timestamp,
              'spawned',
              (block.input as Record<string, unknown>)?.type as string ||
              (block.input as Record<string, unknown>)?.subagent_type as string ||
              'general',
            ),
          );
        }
        // Handle user questions
        if (block.name === 'askUser') {
          events.push(
            createActivityEvent(sessionId, agentId, timestamp, 'waiting'),
          );
        }
      }
    }
  }

  // 2. Handle Usage
  // (Usage is attached to the activity event above if text exists)

  return events;
}

function handleUser(
  raw: RawJsonlEvent,
  sessionId: string,
  agentId: string | null,
  timestamp: string,
): PixelEvent[] {
  const events: PixelEvent[] = [];
  const message = raw.message;
  if (!message?.content) return events;

  const content = typeof message.content === 'string'
    ? [{ type: 'text' as const, text: message.content }]
    : message.content;

  // Handle Tool Results
  if (raw.userType === 'tool_result') {
    const contentList = Array.isArray(content) ? content : [];
    for (const block of contentList) {
      if (block.type === 'tool_result') {
        const isError =
          block.is_error === true ||
          (typeof block.content === 'string' && block.content.includes('Error'));

        events.push(createToolEvent(sessionId, agentId, timestamp, {
          tool: ToolCategory.OTHER,
          status: isError ? 'error' : 'completed',
          toolUseId: block.tool_use_id,
        }));

        if (isError) {
          events.push(createErrorEvent(sessionId, agentId, timestamp, 'warning'));
        }
      }
    }
  } else {
    // Regular user message - check for text content
    const hasText = content.some(
      (b) => b.type === 'text' && 'text' in b && (b as { text: string }).text?.trim(),
    );
    if (hasText) {
      events.push(createActivityEvent(sessionId, agentId, timestamp, 'user_prompt'));
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildToolStartedEvent(
  sessionId: string,
  agentId: string | null,
  timestamp: string,
  block: any,
): PixelEvent {
  const toolName = block.name;
  const mapping = ANTIGRAVITY_TOOL_MAP[toolName] || {
    category: ToolCategory.OTHER,
    detail: toolName,
  };

  const context = extractSafeContext(toolName, block.input);
  return createToolEvent(sessionId, agentId, timestamp, {
    tool: mapping.category,
    detail: mapping.detail,
    status: 'started',
    toolUseId: block.id,
    ...(context && { context }),
  });
}

function extractSafeContext(toolName: string, input: Record<string, unknown> | null): string | null {
  if (!input) return null;

  // Handle search tools first (before generic path extraction)
  if (toolName === 'grepSearch' || toolName === 'Grep') {
    return (input.Query as string) || (input.pattern as string) || null;
  }
  if (toolName === 'globSearch' || toolName === 'Glob') {
    return (input.pattern as string) || null;
  }

  // Privacy: never leak URLs or search queries
  if (toolName === 'readUrl' || toolName === 'WebFetch' || toolName === 'fetchUrl') {
    return null; // Don't leak URLs
  }
  if (toolName === 'searchWeb' || toolName === 'WebSearch') {
    return null; // Don't leak search queries
  }

  // Handle terminal/command tools
  if (toolName === 'runCommand' || toolName === 'Bash') {
    // Antigravity uses CommandLine (capitalized) or command (lowercase)
    return (input.description as string) || 
           (input.CommandLine as string) || 
           (input.command as string) || 
           null;
  }

  // Handle various file path field names (after search/terminal checks)
  // Antigravity standard tool arguments often use Capitalized keys in some versions,
  // or specific argument names like 'CommandLine' vs 'command'.
  if (input.file_path) return toBasename(input.file_path as string);
  if (input.filePath) return toBasename(input.filePath as string);
  if (input.target_file) return toBasename(input.target_file as string);
  if (input.targetFile) return toBasename(input.targetFile as string);
  if (input.TargetFile) return toBasename(input.TargetFile as string);
  if (input.AbsolutePath) return toBasename(input.AbsolutePath as string);
  if (input.path) return toBasename(input.path as string);
  if (input.file) return toBasename(input.file as string);

  // Handle task/agent spawning
  if (toolName === 'spawnAgent' || toolName === 'Task') {
    return (input.type as string) || (input.subagent_type as string) || null;
  }

  // Handle todo/task planning
  if (toolName === 'listTasks' || toolName === 'TodoWrite') {
    return Array.isArray(input.todos) ? `${input.todos.length} items` : null;
  }

  return null;
}

function extractTokens(usage: RawUsage | null): TokenUsage | null {
  if (!usage) return null;

  const tokens: TokenUsage = {
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
  };

  if (usage.cache_read_input_tokens) {
    tokens.cacheRead = usage.cache_read_input_tokens;
  }
  if (usage.cache_creation_input_tokens) {
    tokens.cacheWrite = usage.cache_creation_input_tokens;
  }

  return tokens;
}
