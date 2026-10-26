/**
 * `cursor_api` is the same Cursor usage as `cursor_local`, as Cursor's dashboard reports it: enable
 * one or the other, not both. `grok_bot` rows come from that dashboard too.
 */
export type Source = "claude_code" | "claude_cowork" | "codex" | "cursor_local" | "cursor_api" | "grok_bot";

/** The sources read from local files. The dashboard sources are left out, so enabling all of these
 *  never sends the user's Cursor login anywhere. */
export const SOURCES: readonly Source[] = ["claude_code", "claude_cowork", "codex", "cursor_local"];

export type MessageType = "user" | "assistant";

/** One model turn read from a local log. Never carries message content. */
export interface TokenEvent {
  source: Source;
  sessionId: string;
  /** Subagent id within a session (Claude Code `agentId`); null for the main agent. */
  agentId: string | null;
  messageId: string;
  requestId: string | null;
  timestamp: number;
  model: string;
  /** User events carry zero tokens; they exist only for message counts. */
  messageType: MessageType;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number | null;
  /** Cents Cursor's dashboard charged for the request (`cursor_api` and `grok_bot`); null when it
   *  reported none. Absent for local sources. */
  costCents?: number | null;
}

export interface FileState {
  path: string;
  mtimeMs: number;
  byteOffset: number;
  /** Lines fully parsed in a Cursor transcript JSONL (stable message ids). */
  transcriptLineIndex?: number;
  /** Codex only: cumulative totals at the end of the last read. */
  lastSessionTotals?: {
    sessionId: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    reasoningTokens: number;
  };
  /** Codex only: model in effect at the end of the last read, carried into the next one. */
  lastModel?: string;
}

/** Where each source's last read stopped. Callers persist it and may add their own fields. */
export interface ExtractState {
  files: Record<string, FileState>;
  cursorLocal?: { dbPath: string; lastRowid: number };
  /** The Cursor account last read from the dashboard, and when the whole window was read. */
  cursorApi?: { accountId: string; checkedAt: number };
}
