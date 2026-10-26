import { stat } from "node:fs/promises";
import { parseClaudeCodeFile } from "./claude-code.ts";
import { parseCodexFile } from "./codex.ts";
import { type CursorCredentials, fetchCursorUsagePages, loadCursorCredentials } from "./cursor-api.ts";
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
  /** The files under `dir`, or under the default locations when there is none. */
  list: (dir?: string) => Promise<string[]>;
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
  /** Read only these folders for a source, in place of its default locations (and env). */
  dirs?: Partial<Record<Source, readonly string[]>>;
  cursorDbPath?: string;
  /** Message keys already taken this run. A long-running caller can pass a smaller set, such as one
   *  of hashes. Defaults to a `Set` of the keys. */
  seen?: { has: (key: string) => boolean; add: (key: string) => unknown };
  /** For `cursor_api`: replaces reading the login from `state.vscdb`, and `fetch`. */
  cursorCredentials?: () => CursorCredentials;
  cursorFetch?: typeof fetch;
  now?: () => number;
  onError?: (err: unknown, where: string) => void;
}

/** How often `cursor_api` asks Cursor's dashboard, and how far back it re-reads: Cursor can publish
 *  a request's usage after it finished. */
const CURSOR_API_EVERY_MS = 15 * 60_000;
const CURSOR_API_OVERLAP_MS = 7 * 24 * 60 * 60_000;

/** Files stat'ed at once. */
const STAT_BATCH = 64;

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
  const seen = opts.seen ?? new Set<string>();
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
      const dirs = opts.dirs?.[source.id];
      paths = dirs
        ? [...new Set((await Promise.all(dirs.map((dir) => source.list(dir)))).flat())]
        : await source.list();
    } catch (err) {
      opts.onError?.(err, `list:${source.id}`);
    }
    // Most files haven't changed since the last read, so their stats are the bulk of the work: a
    // batch at a time, not one after another.
    for (let i = 0; i < paths.length; i += STAT_BATCH) {
      const batch = paths.slice(i, i + STAT_BATCH);
      const mtimes = await Promise.all(batch.map(mtimeOf));
      for (const [j, path] of batch.entries()) {
        present.add(path);
        const mtimeMs = mtimes[j];
        if (mtimeMs === null || mtimeMs === undefined) continue;
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

  // The dashboard's whole window is checkpointed once its last page is read; an earlier failure
  // re-reads the window, with the same message ids, next time.
  const now = (opts.now ?? Date.now)();
  if (
    (opts.enabled.has("cursor_api") || opts.enabled.has("grok_bot")) &&
    now - (state.cursorApi?.checkedAt ?? 0) >= CURSOR_API_EVERY_MS
  ) {
    const dbPath = opts.cursorDbPath ?? cursorStateDbPath();
    if (opts.cursorCredentials || (await mtimeOf(dbPath)) !== null) {
      try {
        const credentials = opts.cursorCredentials ?? (() => loadCursorCredentials(dbPath));
        const accountId = credentials().accountId;
        const since =
          state.cursorApi?.accountId === accountId
            ? Math.max(0, state.cursorApi.checkedAt - CURSOR_API_OVERLAP_MS)
            : 0;
        for await (const r of fetchCursorUsagePages({
          dbPath,
          since,
          until: now,
          credentials,
          expectedAccountId: accountId,
          fetch: opts.cursorFetch,
        })) {
          take(r.events.filter((e) => opts.enabled.has(e.source)));
          const batch = flush();
          yield {
            events: batch.events,
            commit: (s) =>
              r.done ? { ...batch.commit(s), cursorApi: { accountId, checkedAt: now } } : batch.commit(s),
          };
        }
      } catch (err) {
        opts.onError?.(err, "cursor_api");
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
