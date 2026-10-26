import { stat } from "node:fs/promises";
import { parseClaudeCodeFile } from "./claude-code.ts";
import { parseCodexFile } from "./codex.ts";
import { parseCursorTranscriptFile } from "./cursor-jsonl.ts";
import { parseCursorLocal } from "./cursor-local.ts";
import {
  cursorStateDbPath,
  listClaudeCodeFiles,
  listClaudeCoworkFiles,
  listCodexFiles,
  listCursorTranscriptFiles,
} from "./paths.ts";
import type { ExtractState, FileState, Source, TokenEvent } from "./types.ts";

/** A file-backed source: list its files, parse one from where the last read stopped. */
export interface FileSource {
  id: Source;
  list: () => Promise<string[]>;
  parse: (
    path: string,
    prev: FileState | undefined,
    mtimeMs: number,
  ) => Promise<{ events: TokenEvent[]; next: FileState }>;
}

const claudeParser =
  (source: "claude_code" | "claude_cowork"): FileSource["parse"] =>
  async (path, prev, mtimeMs) => {
    const r = await parseClaudeCodeFile({ path, byteOffset: prev?.byteOffset ?? 0, source });
    return { events: r.events, next: { path, mtimeMs, byteOffset: r.newOffset } };
  };

export const FILE_SOURCES: readonly FileSource[] = [
  { id: "claude_code", list: listClaudeCodeFiles, parse: claudeParser("claude_code") },
  { id: "claude_cowork", list: listClaudeCoworkFiles, parse: claudeParser("claude_cowork") },
  {
    id: "codex",
    list: listCodexFiles,
    parse: async (path, prev, mtimeMs) => {
      const r = await parseCodexFile({
        path,
        byteOffset: prev?.byteOffset ?? 0,
        ...(prev?.lastSessionTotals ? { prevSessionTotals: prev.lastSessionTotals } : {}),
        ...(prev?.lastModel ? { prevModel: prev.lastModel } : {}),
      });
      const lastModel = r.lastModel ?? prev?.lastModel;
      return {
        events: r.events,
        next: {
          path,
          mtimeMs,
          byteOffset: r.newOffset,
          lastSessionTotals: r.sessionTotals,
          ...(lastModel ? { lastModel } : {}),
        },
      };
    },
  },
  {
    id: "cursor_local",
    list: listCursorTranscriptFiles,
    parse: async (path, prev, mtimeMs) => {
      const r = await parseCursorTranscriptFile({
        path,
        byteOffset: prev?.byteOffset ?? 0,
        fileMtimeMs: mtimeMs,
        startingLineIndex: prev?.transcriptLineIndex ?? 0,
      });
      return {
        events: r.events,
        next: { path, mtimeMs, byteOffset: r.newOffset, transcriptLineIndex: r.nextLineIndex },
      };
    },
  },
];

/** One event per source, message, request and message type. */
const dedupKey = (e: TokenEvent) => `${e.source}\0${e.messageId}\0${e.requestId ?? ""}\0${e.messageType}`;

export interface Batch {
  events: TokenEvent[];
  /** Apply to the state only once `events` are stored, so a failure re-reads them next time. */
  commit: <S extends ExtractState>(state: S) => S;
}

export interface CollectOptions {
  enabled: ReadonlySet<Source>;
  /** Flush a batch once it holds at least this many events. */
  batchSize?: number;
  sources?: readonly FileSource[];
  cursorDbPath?: string;
  onError?: (err: unknown, where: string) => void;
}

async function mtimeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Walk every enabled source and yield batches of new events. Reading resumes
 * from the offsets in `state`; each batch's `commit` advances them. A caller
 * that stops early (send failed) just re-reads the same bytes next time.
 */
export async function* collect(state: ExtractState, opts: CollectOptions): AsyncGenerator<Batch> {
  const batchSize = opts.batchSize ?? 5000;
  const sources = opts.sources ?? FILE_SOURCES;
  const seen = new Set<string>();
  let events: TokenEvent[] = [];
  let pending: FileState[] = [];

  const take = (evs: TokenEvent[]) => {
    for (const e of evs) {
      const k = dedupKey(e);
      if (seen.has(k)) continue;
      seen.add(k);
      events.push(e);
    }
  };
  const flush = (): Batch => {
    const batch = { events, files: pending };
    events = [];
    pending = [];
    return {
      events: batch.events,
      commit: (s) => {
        const files = { ...s.files };
        for (const f of batch.files) files[f.path] = f;
        return { ...s, files };
      },
    };
  };

  const present = new Set<string>();
  for (const source of sources) {
    if (!opts.enabled.has(source.id)) continue;
    let paths: string[] = [];
    try {
      paths = await source.list();
    } catch (err) {
      opts.onError?.(err, `list:${source.id}`);
    }
    for (const path of paths) {
      present.add(path);
      const mtimeMs = await mtimeOf(path);
      if (mtimeMs === null) continue;
      const prev = state.files[path];
      if (prev && mtimeMs <= prev.mtimeMs) continue;
      try {
        const r = await source.parse(path, prev, mtimeMs);
        take(r.events);
        pending.push(r.next);
      } catch (err) {
        opts.onError?.(err, `parse:${path}`);
      }
      if (events.length >= batchSize) yield flush();
    }
  }

  if (opts.enabled.has("cursor_local")) {
    const dbPath = opts.cursorDbPath ?? cursorStateDbPath();
    const dbMtimeMs = await mtimeOf(dbPath);
    if (dbMtimeMs !== null) {
      const lastRowid = state.cursorLocal?.dbPath === dbPath ? state.cursorLocal.lastRowid : 0;
      try {
        const r = parseCursorLocal({ dbPath, lastRowid, dbMtimeMs });
        take(r.events);
        const batch = flush();
        yield {
          events: batch.events,
          commit: (s) => ({ ...batch.commit(s), cursorLocal: { dbPath, lastRowid: r.newRowid } }),
        };
      } catch (err) {
        opts.onError?.(err, `parse:${dbPath}`);
      }
    }
  }

  // Final batch also forgets files that no longer exist on disk.
  const last = flush();
  yield {
    events: last.events,
    commit: (s) => {
      const next = last.commit(s);
      const files: ExtractState["files"] = {};
      for (const [path, f] of Object.entries(next.files)) if (present.has(path)) files[path] = f;
      return { ...next, files };
    },
  };
}
