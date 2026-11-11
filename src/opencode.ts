import { Database } from "bun:sqlite";
import type { OpencodeCursor, OpencodeState, OpencodeTable, TokenEvent } from "./types.ts";

/** Rows read at once, so a first read of a long history comes back in bounded batches. */
export const OPENCODE_PAGE_SIZE = 5000;

/**
 * The tables messages live in, oldest layout first. OpenCode 1.x wrote `message` (`role`, `modelID`);
 * 2.x writes `session_message` (`type`, `model.id`) and copies older sessions into it with the same
 * ids, so a message can be in both.
 */
const TABLES: Record<OpencodeTable, { type: string; model: string; where: string }> = {
  message: {
    type: "json_extract(data, '$.role')",
    model: "json_extract(data, '$.modelID')",
    where: "1",
  },
  session_message: {
    type: "type",
    model: "json_extract(data, '$.model.id')",
    where: "type IN ('user', 'assistant')",
  },
};

interface Row {
  id: string;
  session: string;
  updatedAt: number;
  createdAt: number;
  type: string | null;
  model: string | null;
  created: number | null;
  completed: number | null;
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

/**
 * A finished message as an event, or null. An assistant message still streaming has no
 * `time.completed`; its row is updated when it finishes, so a later read picks it up. OpenCode's
 * `input` excludes cache reads and writes, and its `output` excludes reasoning, which is added back:
 * the other sources report output with reasoning in it.
 */
function toEvent(r: Row): TokenEvent | null {
  const base = {
    source: "opencode",
    sessionId: r.session,
    agentId: null,
    messageId: r.id,
    requestId: null,
    timestamp: count(r.created) || r.createdAt,
  } as const;
  if (r.type === "user") {
    return {
      ...base,
      model: "",
      messageType: "user",
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: null,
    };
  }
  if (r.type !== "assistant" || !r.completed) return null;
  const reasoning = count(r.reasoning);
  const e: TokenEvent = {
    ...base,
    model: r.model || "unknown",
    messageType: "assistant",
    inputTokens: count(r.input),
    outputTokens: count(r.output) + reasoning,
    cacheCreationTokens: count(r.cacheWrite),
    cacheReadTokens: count(r.cacheRead),
    reasoningTokens: reasoning,
  };
  // An aborted or failed request that used no tokens.
  return e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens > 0 ? e : null;
}

export interface OpencodePage {
  table: OpencodeTable;
  events: TokenEvent[];
  /** Where this page stopped; store it under `table` once `events` are stored. */
  cursor: OpencodeCursor;
}

export interface ReadOpencodeDbOptions {
  dbPath: string;
  /** Where the last read of this database stopped, per table. */
  prev?: OpencodeState;
  pageSize?: number;
}

/**
 * The messages in an OpenCode database updated since `prev`, a page at a time per table. Opens the
 * database read-only and closes it when the generator ends. Only ids, times, model names and token
 * counts are selected: message content never leaves SQLite.
 *
 * A message migrated into both tables comes out of each; drop the repeat by its id. A message
 * updated after it was read comes out again with the same id.
 */
export function* readOpencodeDb(opts: ReadOpencodeDbOptions): Generator<OpencodePage> {
  const pageSize = opts.pageSize ?? OPENCODE_PAGE_SIZE;
  const db = new Database(opts.dbPath, { readonly: true });
  try {
    // OpenCode may be writing: wait for it rather than fail the read.
    db.exec("PRAGMA busy_timeout = 2000");
    for (const table of tablesIn(db)) {
      const t = TABLES[table];
      const query = db.query<Row, [number, string]>(
        `SELECT id, session_id AS session, time_updated AS updatedAt, time_created AS createdAt,
           ${t.type} AS type, ${t.model} AS model,
           json_extract(data, '$.time.created') AS created,
           json_extract(data, '$.time.completed') AS completed,
           json_extract(data, '$.tokens.input') AS input,
           json_extract(data, '$.tokens.output') AS output,
           json_extract(data, '$.tokens.reasoning') AS reasoning,
           json_extract(data, '$.tokens.cache.read') AS cacheRead,
           json_extract(data, '$.tokens.cache.write') AS cacheWrite
         FROM ${table}
         WHERE ${t.where} AND (time_updated > ?1 OR (time_updated = ?1 AND id > ?2))
         ORDER BY time_updated, id
         LIMIT ${pageSize}`,
      );
      let cursor = opts.prev?.[table] ?? { updatedAt: -1, id: "" };
      for (;;) {
        const rows = query.all(cursor.updatedAt, cursor.id);
        const last = rows.at(-1);
        if (!last) break;
        cursor = { updatedAt: last.updatedAt, id: last.id };
        yield { table, events: rows.map(toEvent).filter((e) => e !== null), cursor };
        if (rows.length < pageSize) break;
      }
    }
  } finally {
    db.close();
  }
}

function tablesIn(db: Database): OpencodeTable[] {
  const names = new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name),
  );
  return (Object.keys(TABLES) as OpencodeTable[]).filter((t) => names.has(t));
}
