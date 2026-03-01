/**
 * Memory Tools
 *
 * Provides the LLM with tools to persist important information:
 * - update_memory: Update long-term memory (MEMORY.md) — user preferences, key facts, relationships
 * - append_history: Add an entry to the history log (HISTORY.md) — conversation summaries, events
 * - search_history: Search through past history entries
 *
 * These tools are backed by the MemoryStore, injected at app startup via setMemoryToolDeps().
 */

import type { Tool, ToolParametersSchema, ToolContext } from '../types/tool.js';
import type { MemoryStore } from '../memory/memory-store.js';
import { ToolExecutionError } from '../core/errors.js';

// ─── Module-level dependency ───

let memoryStoreInstance: MemoryStore | null = null;

/**
 * Inject MemoryStore instance (called during App initialization)
 */
export function setMemoryToolDeps(store: MemoryStore): void {
  memoryStoreInstance = store;
}

function getMemoryStore(): MemoryStore {
  if (!memoryStoreInstance) {
    throw new Error('MemoryTool dependency not injected. Call setMemoryToolDeps() first.');
  }
  return memoryStoreInstance;
}

/**
 * Update Memory Tool — Replace the entire long-term memory file
 *
 * The AI should use this to maintain a structured knowledge base about each user:
 * preferences, important facts, relationships, recurring patterns, etc.
 *
 * The content is written in Markdown and fully replaces the previous memory.
 * The AI should read the current memory first (it's in the system prompt) and
 * merge new information with existing content.
 */
export class UpdateMemoryTool implements Tool {
  readonly name = 'update_memory';
  readonly description =
    'Update the long-term memory file (MEMORY.md). This replaces the entire memory content. ' +
    'Use this to persist important user information: preferences, key facts, relationships, habits, ' +
    'important dates, and any recurring patterns you observe. ' +
    'The current memory content is already available in your system prompt under <memory> tags. ' +
    'When updating, merge new information with existing content — do not discard old facts unless they are outdated. ' +
    'Write in well-structured Markdown format.';

  readonly parameters: ToolParametersSchema = {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description:
          'The complete memory content in Markdown format. This replaces the entire memory file. ' +
          'Include all existing facts that are still relevant, plus any new information. ' +
          'Organize by categories such as: User Profile, Preferences, Key Facts, Relationships, Notes.',
      },
    },
    required: ['content'],
  };

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<string> {
    const content = params['content'] as string;

    if (!content || content.trim().length === 0) {
      throw new ToolExecutionError(this.name, params, new Error('Memory content cannot be empty'));
    }

    const store = getMemoryStore();
    await store.updateMemory(content);

    return '✅ Long-term memory has been updated successfully.';
  }
}

/**
 * Append History Tool — Add a timestamped entry to the history log
 *
 * The AI should use this to record significant events, conversation summaries,
 * decisions, and actions taken. This creates a searchable timeline.
 */
export class AppendHistoryTool implements Tool {
  readonly name = 'append_history';
  readonly description =
    'Append an entry to the history log (HISTORY.md). ' +
    'Use this to record significant events, conversation summaries, decisions made, ' +
    'actions taken, or any noteworthy interaction. ' +
    'Each entry is timestamped automatically. This creates a searchable timeline of events.';

  readonly parameters: ToolParametersSchema = {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description:
          'A concise summary of the event or interaction to record. ' +
          'Keep it brief but informative. ' +
          'Examples: "User requested reminder for grandpa\'s medicine", ' +
          '"Updated family space with new member", ' +
          '"User prefers responses in Chinese".',
      },
      source: {
        type: 'string',
        description:
          'Optional tag indicating the source or category. ' +
          'Examples: "conversation", "task", "preference", "decision".',
      },
    },
    required: ['content'],
  };

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<string> {
    const content = params['content'] as string;
    const source = params['source'] as string | undefined;

    if (!content || content.trim().length === 0) {
      throw new ToolExecutionError(this.name, params, new Error('History entry content cannot be empty'));
    }

    const store = getMemoryStore();
    await store.appendHistory({
      timestamp: Date.now(),
      content: content.trim(),
      source: source?.trim(),
    });

    return '✅ History entry has been recorded.';
  }
}

/**
 * Search History Tool — Search through the history log
 *
 * Allows the AI to look up past events and interactions by keyword.
 */
export class SearchHistoryTool implements Tool {
  readonly name = 'search_history';
  readonly description =
    'Search through the history log (HISTORY.md) for past events and interactions. ' +
    'Use this when you need to recall past events, decisions, or interactions. ' +
    'Returns matching entries from the history timeline.';

  readonly parameters: ToolParametersSchema = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search keyword or phrase to look for in history entries.',
      },
    },
    required: ['query'],
  };

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<string> {
    const query = params['query'] as string;

    if (!query || query.trim().length === 0) {
      throw new ToolExecutionError(this.name, params, new Error('Search query cannot be empty'));
    }

    const store = getMemoryStore();
    const results = await store.searchHistory(query.trim());

    if (results.length === 0) {
      return `No history entries found matching "${query}".`;
    }

    return [
      `Found ${results.length} matching entries:`,
      '',
      ...results,
    ].join('\n');
  }
}
