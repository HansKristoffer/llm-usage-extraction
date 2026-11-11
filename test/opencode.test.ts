import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CollectOptions, collect } from "../src/collect.ts";
import { readOpencodeDb } from "../src/opencode.ts";
import { listOpencodeDbs, opencodeDataDir } from "../src/paths.ts";
import type { ExtractState, TokenEvent } from "../src/types.ts";

let dir: string;
const env = ["XDG_DATA_HOME", "OPENCODE_DB"] as const;
const saved = env.map((k) => process.env[k]);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lue-opencode-"));
  process.env.XDG_DATA_HOME = join(dir, "xdg");
  delete process.env.OPENCODE_DB;
});

afterEach(() => {
  for (const [i, k] of env.entries()) {
    const v = saved[i];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

const tokens = { input: 100, output: 20, reasoning: 5, cache: { read: 1000, write: 50 } };

/** An OpenCode 2.x database: older sessions in `message`, new ones in `session_message`. */
function opencodeDb(path = join(dir, "opencode.db")) {
  const db = new Database(path);
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`);
  db.exec(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
    seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`);
  let seq = 0;
  return {
    db,
    path,
    v1: (id: string, updated: number, data: object, session = "ses_a") =>
      db
        .query("INSERT OR REPLACE INTO message VALUES (?, ?, ?, ?, ?)")
        .run(id, session, 1000, updated, JSON.stringify(data)),
    v2: (id: string, type: string, updated: number, data: object, session = "ses_b") =>
      db
        .query("INSERT OR REPLACE INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, session, type, seq++, 2000, updated, JSON.stringify(data)),
  };
}

const done = (model: string, created: number) => ({
  role: "assistant",
  modelID: model,
  tokens,
  time: { created, completed: created + 1 },
});

async function drain(state: ExtractState, opts: Partial<CollectOptions> = {}) {
  const events: TokenEvent[] = [];
  for await (const batch of collect(state, {
    enabled: new Set(["opencode"]),
    dirs: { opencode: [dir] },
    onError: (err) => {
      throw err;
    },
    ...opts,
  })) {
    events.push(...batch.events);
    state = batch.commit(state);
  }
  return { events, state };
}

describe("OpenCode", () => {
  test("reads finished messages from both tables, once, without their content", async () => {
    const { db, path, v1, v2 } = opencodeDb();
    v1("msg_u1", 10, { role: "user", time: { created: 1500 }, content: "secret prompt" });
    v1("msg_a1", 11, { ...done("claude-sonnet-4-5", 1600), providerID: "anthropic" });
    // Still streaming: no `time.completed` yet.
    v1("msg_a2", 12, { role: "assistant", modelID: "claude-sonnet-4-5", tokens, time: { created: 1800 } });
    // Aborted before any tokens.
    v1("msg_a3", 13, {
      ...done("claude-sonnet-4-5", 1900),
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    // msg_a1 migrated into the 2.x table with the same id.
    v2("msg_a1", "assistant", 11, {
      model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
      tokens,
      time: { created: 1600, completed: 1601 },
    });
    v2("msg_b1", "assistant", 20, {
      model: { providerID: "openrouter", id: "z-ai/glm-5.3" },
      content: [{ type: "text", text: "secret answer" }],
      tokens,
      time: { created: 2100, completed: 2200 },
    });
    v2("msg_b2", "assistant", 21, { model: { id: "" }, tokens, time: { created: 2300, completed: 2400 } });
    v2("msg_s1", "system", 22, { text: "secret" });
    db.close();

    const { events, state } = await drain({ files: {} });

    expect(events.map((e) => [e.messageId, e.messageType, e.model])).toEqual([
      ["msg_u1", "user", ""],
      ["msg_a1", "assistant", "claude-sonnet-4-5"],
      ["msg_b1", "assistant", "z-ai/glm-5.3"],
      ["msg_b2", "assistant", "unknown"],
    ]);
    expect(events[1]).toEqual({
      source: "opencode",
      sessionId: "ses_a",
      agentId: null,
      messageId: "msg_a1",
      requestId: null,
      timestamp: 1600,
      model: "claude-sonnet-4-5",
      messageType: "assistant",
      inputTokens: 100,
      outputTokens: 25,
      cacheCreationTokens: 50,
      cacheReadTokens: 1000,
      reasoningTokens: 5,
    });
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(state.opencode).toEqual({
      [path]: {
        message: { updatedAt: 13, id: "msg_a3" },
        session_message: { updatedAt: 21, id: "msg_b2" },
      },
    });
  });

  test("resumes after the last row, and picks up a message when it finishes", async () => {
    const { db, v1 } = opencodeDb();
    const streaming = { role: "assistant", modelID: "gpt-5", tokens, time: { created: 1600 } };
    v1("msg_a1", 10, streaming);
    const first = await drain({ files: {} });
    expect(first.events).toHaveLength(0);

    v1("msg_a1", 30, { ...streaming, time: { created: 1600, completed: 1700 } });
    v1("msg_a0", 30, done("gpt-5", 1500));
    const second = await drain(first.state);
    expect(second.events.map((e) => e.messageId)).toEqual(["msg_a0", "msg_a1"]);

    expect((await drain(second.state)).events).toHaveLength(0);
    db.close();
  });

  test("an uncommitted batch is read again", async () => {
    const { db, v1 } = opencodeDb();
    v1("msg_a1", 10, done("gpt-5", 1));
    db.close();
    for await (const _ of collect(
      { files: {} },
      { enabled: new Set(["opencode"]), dirs: { opencode: [dir] } },
    ))
      break;
    expect((await drain({ files: {} })).events.map((e) => e.messageId)).toEqual(["msg_a1"]);
  });

  test("reads a page at a time, each with where it stopped", () => {
    const { db, path, v1 } = opencodeDb();
    for (const [i, id] of ["a", "b", "c"].entries()) v1(id, 10, done("gpt-5", i + 1));
    v1("d", 11, done("gpt-5", 4));
    db.close();
    const pages = [...readOpencodeDb({ dbPath: path, pageSize: 2 })];
    expect(pages.map((p) => [p.table, p.events.map((e) => e.messageId), p.cursor])).toEqual([
      ["message", ["a", "b"], { updatedAt: 10, id: "b" }],
      ["message", ["c", "d"], { updatedAt: 11, id: "d" }],
    ]);
    const rest = [...readOpencodeDb({ dbPath: path, pageSize: 2, prev: { message: pages[0]!.cursor } })];
    expect(rest.flatMap((p) => p.events.map((e) => e.messageId))).toEqual(["c", "d"]);
  });

  test("finds databases in OpenCode's data dir, each channel's, and OPENCODE_DB", async () => {
    expect(opencodeDataDir()).toBe(join(dir, "xdg", "opencode"));
    const data = opencodeDataDir();
    expect(listOpencodeDbs()).toEqual([]);

    mkdirSync(data, { recursive: true });
    for (const name of ["opencode.db", "opencode-local.db"]) {
      const { db, v1 } = opencodeDb(join(data, name));
      v1(`msg_${name}`, 10, done("gpt-5", 1));
      db.close();
    }
    writeFileSync(join(data, "opencode.db-wal"), "");
    const custom = opencodeDb(join(dir, "custom.db"));
    custom.v1("msg_custom", 10, done("gpt-5", 1));
    custom.db.close();
    process.env.OPENCODE_DB = join(dir, "custom.db");

    expect(listOpencodeDbs()).toEqual([
      join(data, "opencode-local.db"),
      join(data, "opencode.db"),
      join(dir, "custom.db"),
    ]);
    const { events } = await drain({ files: {} }, { dirs: {} });
    expect(events.map((e) => e.messageId)).toEqual([
      "msg_opencode-local.db",
      "msg_opencode.db",
      "msg_custom",
    ]);
  });

  test("no OpenCode folder is not an error", async () => {
    const errors: string[] = [];
    const { events } = await drain(
      { files: {} },
      { dirs: { opencode: [join(dir, "missing")] }, onError: (_e, where) => errors.push(where) },
    );
    expect(events).toHaveLength(0);
    expect(errors).toEqual([]);
  });

  test("a database that is not OpenCode's is reported, and the rest still read", async () => {
    writeFileSync(join(dir, "opencode-broken.db"), "not sqlite");
    const { db, v1 } = opencodeDb();
    v1("msg_a1", 10, done("gpt-5", 1));
    db.close();
    const errors: string[] = [];
    const { events } = await drain({ files: {} }, { onError: (_e, where) => errors.push(where) });
    expect(errors).toEqual([`parse:${join(dir, "opencode-broken.db")}`]);
    expect(events.map((e) => e.messageId)).toEqual(["msg_a1"]);
  });
});
