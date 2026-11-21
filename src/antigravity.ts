import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AntigravityCursor, TokenEvent } from "./types.ts";

/**
 * Antigravity keeps one file per conversation (a "cascade") in `<data dir>/conversations/`:
 *
 * - `<cascadeId>.db`, SQLite, written since Antigravity 2. Its `gen_metadata` table holds one
 *   protobuf row per model call, written when the call finishes, with the call's token usage. It
 *   is read here directly, so the app does not need to be running.
 * - `<cascadeId>.pb`, written by Antigravity 1 and encrypted. Only Antigravity's own language
 *   server can read it, so its usage is asked from the server the app runs on `127.0.0.1`. While
 *   the app is closed these files wait for a later read.
 *
 * Message ids are `<cascadeId>:gen:<row>` for a model call and `<cascadeId>:step:<row>` for a user
 * message, the same for both formats, so a conversation that moves from `.pb` to `.db` keeps its
 * ids. `requestId` is the provider's response id, when Antigravity recorded one.
 */

/** `CortexStepType` values in the `steps` table. */
const STEP_USER_INPUT = 14;

// ---------------------------------------------------------------------------------------------------
// The protobuf fields read, from the descriptors in Antigravity's language server.
//
// CortexStepGeneratorMetadata: chat_model 1, step_indices 2
// ChatModelMetadata: usage 4, chat_start_metadata 9, response_model 19, model_display_name 21
// ModelUsageStats: input 2, output 3, cache_write 4, cache_read 5, thinking 9, response 10,
//   response_id 11
// ChatStartMetadata: created_at 4
// CortexStepMetadata: created_at 1
// Timestamp: seconds 1, nanos 2
// ---------------------------------------------------------------------------------------------------

type Fields = Map<number, (number | Uint8Array)[]>;

/** The varint at `buf[pos]`, and where the next field starts. */
function varint(buf: Uint8Array, pos: number): [number, number] {
  let value = 0;
  let scale = 1;
  for (let i = pos; i < buf.length; i++) {
    const byte = buf[i]!;
    value += (byte & 0x7f) * scale;
    if (byte < 0x80) return [value, i + 1];
    scale *= 128;
  }
  throw new Error("Truncated Antigravity protobuf.");
}

/** One level of a protobuf message: varints as numbers, length-delimited fields as views. */
function fields(buf: Uint8Array): Fields {
  const out: Fields = new Map();
  let i = 0;
  while (i < buf.length) {
    const [key, afterKey] = varint(buf, i);
    const wire = key % 8;
    let value: number | Uint8Array;
    if (wire === 0) [value, i] = varint(buf, afterKey);
    else if (wire === 2) {
      const [length, start] = varint(buf, afterKey);
      if (start + length > buf.length) throw new Error("Truncated Antigravity protobuf.");
      value = buf.subarray(start, start + length);
      i = start + length;
    } else if (wire === 1 || wire === 5) {
      i = afterKey + (wire === 1 ? 8 : 4);
      continue;
    } else throw new Error("Unsupported Antigravity protobuf.");
    const no = Math.floor(key / 8);
    const list = out.get(no);
    if (list) list.push(value);
    else out.set(no, [value]);
  }
  return out;
}

const num = (f: Fields | null, no: number) => {
  const v = f?.get(no)?.[0];
  return typeof v === "number" ? v : 0;
};
const sub = (f: Fields | null, no: number): Fields | null => {
  const v = f?.get(no)?.[0];
  return v instanceof Uint8Array ? fields(v) : null;
};
const text = (f: Fields | null, no: number) => {
  const v = f?.get(no)?.[0];
  return v instanceof Uint8Array ? new TextDecoder().decode(v) : "";
};
/** A `google.protobuf.Timestamp` in ms, or 0. */
const time = (t: Fields | null) => num(t, 1) * 1000 + Math.floor(num(t, 2) / 1e6);
/** The first `step_indices` entry, packed or not. */
const firstIndex = (f: Fields) => {
  const v = f.get(2)?.[0];
  if (typeof v === "number") return v;
  return v && v.length > 0 ? varint(v, 0)[0] : null;
};

// ---------------------------------------------------------------------------------------------------

interface Call {
  timestamp: number;
  model: string;
  responseId: string;
  input: number;
  output: number;
  thinking: number;
  response: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Antigravity's `input` excludes cache reads, and `output` is thinking plus response, which matches
 * how the other sources count. Older calls may leave `output` out, so it is never less than the
 * parts.
 */
function callEvent(cascadeId: string, row: number, c: Call): TokenEvent | null {
  const e: TokenEvent = {
    source: "antigravity",
    sessionId: cascadeId,
    agentId: null,
    messageId: `${cascadeId}:gen:${row}`,
    requestId: c.responseId || null,
    timestamp: c.timestamp,
    model: c.model || "unknown",
    messageType: "assistant",
    inputTokens: c.input,
    outputTokens: Math.max(c.output, c.thinking + c.response),
    cacheCreationTokens: c.cacheWrite,
    cacheReadTokens: c.cacheRead,
    reasoningTokens: c.thinking,
  };
  // A call that failed before the model answered.
  return e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens > 0 ? e : null;
}

function userEvent(cascadeId: string, row: number, timestamp: number): TokenEvent {
  return {
    source: "antigravity",
    sessionId: cascadeId,
    agentId: null,
    messageId: `${cascadeId}:step:${row}`,
    requestId: null,
    timestamp,
    model: "",
    messageType: "user",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: null,
  };
}

export interface AntigravityRead {
  events: TokenEvent[];
  /** Where this read stopped; null when the file can't be read right now (a `.pb` while the app is
   *  closed), so it is tried again next time. */
  cursor: AntigravityCursor | null;
}

export interface ParseAntigravityOptions {
  path: string;
  prev?: AntigravityCursor;
  /** Timestamp for a call that recorded none. */
  fileMtimeMs: number;
  /** For `.pb` files: replaces `fetch` to the language server. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Antigravity's databases use a write-ahead log. While it has one open, SQLite keeps `-wal` and
 * `-shm` beside it and a read-only connection shares them. Once it closes the conversation they are
 * gone, and a read-only connection can't make them, so the file is opened as immutable instead:
 * with no `-wal`, every change is already in the file. Nothing is ever written next to it.
 */
function openReadOnly(path: string): Database {
  const db = new Database(path, { readonly: true });
  try {
    // Antigravity may be writing: wait for it rather than fail the read.
    db.exec("PRAGMA busy_timeout = 2000");
    db.query("SELECT 1 FROM sqlite_master LIMIT 1").get();
    return db;
  } catch (err) {
    db.close();
    if ((err as { code?: string }).code !== "SQLITE_CANTOPEN" || existsSync(`${path}-wal`)) throw err;
    return new Database(`${pathToFileURL(path).href}?immutable=1`, { readonly: true });
  }
}

/** The calls and user messages added to a conversation file since `prev`. */
export async function parseAntigravityFile(opts: ParseAntigravityOptions): Promise<AntigravityRead> {
  return extname(opts.path) === ".db" ? readAntigravityDb(opts) : readAntigravityServer(opts);
}

/**
 * New rows of a `.db` conversation, opened read-only. Only token counts, model names, ids and times
 * are decoded: the prompts in the same rows are skipped over. A conversation rewound to fewer rows
 * than were read is read again from the start, with the same ids.
 */
export function readAntigravityDb(opts: ParseAntigravityOptions): AntigravityRead {
  const cascadeId = basename(opts.path, ".db");
  const db = openReadOnly(opts.path);
  try {
    const rows = (table: string) =>
      db.query<{ n: number }, []>(`SELECT COALESCE(MAX(idx) + 1, 0) AS n FROM ${table}`).get()!.n;
    const genTotal = rows("gen_metadata");
    const stepTotal = rows("steps");
    const genFrom = (opts.prev?.generators ?? 0) <= genTotal ? (opts.prev?.generators ?? 0) : 0;
    const stepFrom = (opts.prev?.steps ?? 0) <= stepTotal ? (opts.prev?.steps ?? 0) : 0;

    const stepMeta = db.query<{ metadata: Uint8Array | null }, [number]>(
      "SELECT metadata FROM steps WHERE idx = ?",
    );
    const stepTime = (idx: number | null) => {
      const meta = idx === null ? null : stepMeta.get(idx)?.metadata;
      return meta ? time(sub(fields(meta), 1)) : 0;
    };

    const events: TokenEvent[] = [];
    const users = db
      .query<{ idx: number; metadata: Uint8Array | null }, [number, number]>(
        "SELECT idx, metadata FROM steps WHERE step_type = ? AND idx >= ? ORDER BY idx",
      )
      .all(STEP_USER_INPUT, stepFrom);
    for (const u of users) {
      const at = u.metadata ? time(sub(fields(u.metadata), 1)) : 0;
      events.push(userEvent(cascadeId, u.idx, at || opts.fileMtimeMs));
    }

    const gens = db
      .query<{ idx: number; data: Uint8Array | null }, [number]>(
        "SELECT idx, data FROM gen_metadata WHERE idx >= ? ORDER BY idx",
      )
      .all(genFrom);
    for (const g of gens) {
      if (!g.data) continue;
      const meta = fields(g.data);
      const chat = sub(meta, 1);
      const usage = sub(chat, 4);
      if (!usage) continue;
      const e = callEvent(cascadeId, g.idx, {
        timestamp: time(sub(sub(chat, 9), 4)) || stepTime(firstIndex(meta)) || opts.fileMtimeMs,
        model: text(chat, 19) || text(chat, 21),
        responseId: text(usage, 11),
        input: num(usage, 2),
        output: num(usage, 3),
        thinking: num(usage, 9),
        response: num(usage, 10),
        cacheRead: num(usage, 5),
        cacheWrite: num(usage, 4),
      });
      if (e) events.push(e);
    }
    events.sort((a, b) => a.timestamp - b.timestamp);
    return { events, cursor: { generators: genTotal, steps: stepTotal } };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------------------------------
// The language server, for `.pb` conversations.

interface Server {
  port: number;
  csrfToken: string;
}

/**
 * The running language server, from the `daemon/hub_<port>.json` it writes next to `conversations/`.
 * A file left by a server that has exited is skipped.
 */
function findServer(dataDir: string): Server | null {
  const daemon = join(dataDir, "daemon");
  let names: string[];
  try {
    names = readdirSync(daemon).filter((n) => /^hub_\d+\.json$/.test(n));
  } catch {
    return null;
  }
  const found: (Server & { mtimeMs: number })[] = [];
  for (const name of names) {
    try {
      const path = join(daemon, name);
      const d = JSON.parse(readFileSync(path, "utf8"));
      const port = d.httpPort;
      if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
      if (typeof d.csrfToken !== "string" || d.csrfToken.length === 0) continue;
      if (!Number.isInteger(d.pid) || !alive(d.pid)) continue;
      found.push({ port, csrfToken: d.csrfToken, mtimeMs: statSync(path).mtimeMs });
    } catch {
      // Being written, or not a server file.
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs)[0] ?? null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const count = (v: unknown) => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};
const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * A `.pb` conversation's calls since `prev`, from `GetCascadeTrajectoryGeneratorMetadata` on the
 * language server, which decrypts it. The reply holds each call's prompt too; only its usage is
 * kept. User messages are not counted for these older conversations: they would need the whole
 * conversation fetched.
 */
async function readAntigravityServer(opts: ParseAntigravityOptions): Promise<AntigravityRead> {
  const cascadeId = basename(opts.path, ".pb");
  const server = findServer(dirname(dirname(opts.path)));
  const from = opts.prev?.generators ?? 0;
  if (!server) return { events: [], cursor: null };
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(
      `http://127.0.0.1:${server.port}/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          "X-Codeium-Csrf-Token": server.csrfToken,
        },
        body: JSON.stringify({ cascadeId, generatorMetadataOffset: from }),
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    // Closed between finding it and asking it.
    return { events: [], cursor: null };
  }
  // A conversation the server doesn't know, such as one from another install: read once it changes.
  if (res.status === 404) return { events: [], cursor: { generators: from, steps: 0 } };
  // Never put the reply in the error: it can hold the user's prompts.
  if (!res.ok) throw new Error(`Antigravity's language server answered ${res.status}.`);
  const body = (await res.json()) as { generatorMetadata?: unknown };
  const list = Array.isArray(body.generatorMetadata) ? body.generatorMetadata : [];
  const events: TokenEvent[] = [];
  for (const [i, entry] of list.entries()) {
    const chat = (entry as { chatModel?: Record<string, unknown> } | null)?.chatModel;
    const usage = chat?.usage as Record<string, unknown> | undefined;
    if (!chat || !usage) continue;
    const start = chat.chatStartMetadata as { createdAt?: unknown } | undefined;
    const e = callEvent(cascadeId, from + i, {
      timestamp: Date.parse(str(start?.createdAt)) || opts.fileMtimeMs,
      // Older calls name the model only by an internal id such as MODEL_PLACEHOLDER_M8.
      model: str(chat.responseModel) || str(chat.modelDisplayName) || str(usage.model),
      responseId: str(usage.responseId),
      input: count(usage.inputTokens),
      output: count(usage.outputTokens),
      thinking: count(usage.thinkingOutputTokens),
      response: count(usage.responseOutputTokens),
      cacheRead: count(usage.cacheReadTokens),
      cacheWrite: count(usage.cacheWriteTokens),
    });
    if (e) events.push(e);
  }
  return { events, cursor: { generators: from + list.length, steps: 0 } };
}

/**
 * When a conversation last changed. A `.db` is written through its write-ahead log, so the log's
 * time counts too: the database file itself changes only when SQLite folds the log back in.
 */
export async function antigravityMtime(path: string): Promise<number | null> {
  const times = await Promise.all(
    (extname(path) === ".db" ? [path, `${path}-wal`] : [path]).map((p) =>
      stat(p).then(
        (s) => s.mtimeMs,
        () => null,
      ),
    ),
  );
  if (times[0] === null || times[0] === undefined) return null;
  return Math.max(...times.map((t) => t ?? 0));
}
