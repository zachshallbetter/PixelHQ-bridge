import {
  createActivityEvent,
  createToolEvent,
  createAgentEvent,
  createErrorEvent,
  createSummaryEvent,
  toBasename,
} from '../pixel-events.js';
import { TOOL_TO_CATEGORY, ToolCategory } from '../config.js';
import type { PixelEvent, RawJsonlEvent, RawUsage, TokenUsage } from '../types.js';

/**
 * Transform a raw Cursor JSONL object into PixelEvent(s).
 * Privacy-safe: strips all text content, full paths, commands, URLs, and queries.
 * 
 * Cursor's format is similar to Claude Code, using:
 * - type: "assistant" | "user" | "system" | "summary"
 * - message.content: array of content blocks
 * - tool_use blocks with id, name, input
 * - tool_result blocks with tool_use_id
 */
export function cursorAdapter(raw: RawJsonlEvent): PixelEvent[] {
  const sessionId = raw._sessionId;
  const agentId = raw._agentId || null;
  const timestamp = raw.timestamp || new Date().toISOString();

  switch (raw.type) {
    case 'assistant':
      return handleAssistant(raw, sessionId, agentId, timestamp);

    case 'user':
      return handleUser(raw, sessionId, agentId, timestamp);

    case 'summary':
      return [createSummaryEvent(sessionId, timestamp)];

    case 'system':
    case 'progress':
      return [];

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Assistant message handling
// ---------------------------------------------------------------------------

function handleAssistant(
  raw: RawJsonlEvent,
  sessionId: string,
  agentId: string | null,
  timestamp: string,
): PixelEvent[] {
  const events: PixelEvent[] = [];
  const message = raw.message;
  if (!message?.content) return events;

  // content must be an array for assistant messages
  if (!Array.isArray(message.content)) return events;

  const tokens = extractTokens(message.usage ?? null);

  for (const block of message.content) {
    switch (block.type) {
      case 'thinking':
        events.push(
          createActivityEvent(sessionId, agentId, timestamp, 'thinking'),
        );
        break;

      case 'text':
        if (block.text === '(no content)' || !block.text?.trim()) {
          events.push(
            createActivityEvent(sessionId, agentId, timestamp, 'thinking'),
          );
        } else {
          events.push(
            createActivityEvent(sessionId, agentId, timestamp, 'responding', tokens),
          );
        }
        break;

      case 'tool_use':
        events.push(
          buildToolStartedEvent(sessionId, agentId, timestamp, block),
        );
        // Handle agent spawning
        if (block.name === 'Task') {
          events.push(
            createAgentEvent(
              sessionId,
              block.id,
              timestamp,
              'spawned',
              (block.input as Record<string, unknown>)?.subagent_type as string ||
              (block.input as Record<string, unknown>)?.type as string ||
              'general',
            ),
          );
        }
        // Handle user questions
        if (block.name === 'AskUserQuestion') {
          events.push(
            createActivityEvent(sessionId, agentId, timestamp, 'waiting'),
          );
        }
        break;
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// User message handling
// ---------------------------------------------------------------------------

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

  if (raw.userType === 'tool_result') {
    for (const block of content) {
      if (block.type === 'tool_result') {
        const isError =
          block.is_error === true ||
          (typeof block.content === 'string' && block.content.includes('Error'));

        events.push(
          createToolEvent(sessionId, agentId, timestamp, {
            tool: ToolCategory.OTHER,
            status: isError ? 'error' : 'completed',
            toolUseId: block.tool_use_id,
          }),
        );

        if (isError) {
          events.push(
            createErrorEvent(sessionId, agentId, timestamp, 'warning'),
          );
        }
      }
    }
  } else {
    const hasText = content.some(
      (b) => b.type === 'text' && 'text' in b && (b as { text: string }).text?.trim(),
    );
    if (hasText) {
      events.push(
        createActivityEvent(sessionId, agentId, timestamp, 'user_prompt'),
      );
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

function buildToolStartedEvent(
  sessionId: string,
  agentId: string | null,
  timestamp: string,
  block: ToolUseBlock,
): PixelEvent {
  const toolName = block.name;
  const mapping = TOOL_TO_CATEGORY[toolName] || {
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
  if (toolName === 'Grep' || toolName === 'grep') {
    return (input.pattern as string) || null;
  }
  if (toolName === 'Glob' || toolName === 'glob') {
    return (input.pattern as string) || null;
  }

  // Privacy: never leak URLs or search queries
  if (toolName === 'WebFetch' || toolName === 'fetchUrl' || toolName === 'fetch_url') {
    return null; // Don't leak URLs
  }
  if (toolName === 'WebSearch' || toolName === 'webSearch' || toolName === 'web_search') {
    return null; // Don't leak search queries
  }

  // Handle terminal/command tools
  if (toolName === 'Bash' || toolName === 'runCommand' || toolName === 'run_command' || toolName === 'execute_command') {
    return (input.description as string) || null;
  }

  // Handle various file path field names (after search/terminal checks)
  if (input.file_path) return toBasename(input.file_path as string);
  if (input.filePath) return toBasename(input.filePath as string);
  if (input.target_file) return toBasename(input.target_file as string);
  if (input.targetFile) return toBasename(input.targetFile as string);
  if (input.path) return toBasename(input.path as string);
  if (input.file) return toBasename(input.file as string);

  // Handle task/agent spawning
  if (toolName === 'Task' || toolName === 'spawnAgent' || toolName === 'spawn_agent') {
    return (input.subagent_type as string) || (input.type as string) || null;
  }

  // Handle todo/task planning
  if (toolName === 'TodoWrite' || toolName === 'create_task' || toolName === 'list_tasks') {
    return Array.isArray(input.todos) ? `${input.todos.length} items` : null;
  }

  // Handle notebook editing
  if (toolName === 'NotebookEdit' || toolName === 'edit_notebook') {
    if (input.notebook_path) return toBasename(input.notebook_path as string);
    if (input.notebookPath) return toBasename(input.notebookPath as string);
    return null;
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
