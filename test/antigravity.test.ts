import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAntigravityFile } from "../src/antigravity.ts";
import { type CollectOptions, collect } from "../src/collect.ts";
import { antigravityCliDir, antigravityDir, listAntigravityFiles } from "../src/paths.ts";
import type { ExtractState, TokenEvent } from "../src/types.ts";

let dir: string;
let conversations: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lue-antigravity-"));
  conversations = join(dir, "conversations");
  mkdirSync(conversations);
});

afterEach(() => {
  delete process.env.ANTIGRAVITY_DATA_DIR;
  delete process.env.ANTIGRAVITY_CLI_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

// A protobuf writer for fixtures: a number is a varint, anything else is length-delimited.
type Value = number | string | Uint8Array;
const varint = (n: number) => {
  const out: number[] = [];
  for (; n >= 0x80; n = Math.floor(n / 128)) out.push((n % 128) | 0x80);
  out.push(n);
  return out;
};
const pb = (...fields: [number, Value][]) =>
  Uint8Array.from(
    fields.flatMap(([no, v]) => {
      if (typeof v === "number") return [...varint(no * 8), ...varint(v)];
      const bytes = typeof v === "string" ? new TextEncoder().encode(v) : v;
      return [...varint(no * 8 + 2), ...varint(bytes.length), ...bytes];
    }),
  );
const timestamp = (ms: number) => pb([1, Math.floor(ms / 1000)], [2, (ms % 1000) * 1e6]);

/** A `gen_metadata` row: one model call. */
function call(o: {
  step: number;
  usage?: Uint8Array;
  model?: string;
  displayName?: string;
  startedAt?: number;
}): Uint8Array {
  const chat: [number, Value][] = [[1, "secret system prompt"]];
  if (o.usage) chat.push([4, o.usage]);
  if (o.startedAt) chat.push([9, pb([1, 0], [4, timestamp(o.startedAt)])]);
  if (o.model) chat.push([19, o.model]);
  if (o.displayName) chat.push([21, o.displayName]);
  // step_indices is packed: [step, step + 1].
  return pb([2, Uint8Array.from([o.step, o.step + 1])], [3, pb([1, 1198])], [1, pb(...chat)]);
}

const usage = (o: Partial<Record<"input" | "output" | "thinking" | "response" | "write" | "read", number>>) =>
  pb(
    [1, 1198],
    [2, o.input ?? 0],
    [3, o.output ?? 0],
    [4, o.write ?? 0],
    [5, o.read ?? 0],
    [9, o.thinking ?? 0],
    [10, o.response ?? 0],
    [11, "resp-1"],
  );

/** A conversation database in Antigravity 2's layout. */
function conversation(id: string) {
  const path = join(conversations, `${id}.db`);
  const db = new Database(path);
  db.exec(`CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0,
    status integer NOT NULL DEFAULT 0, metadata blob, step_payload blob)`);
  db.exec("CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob, size integer NOT NULL DEFAULT 0)");
  return {
    db,
    path,
    step: (idx: number, type: number, createdAt: number) =>
      db
        .query("INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, 3, ?, ?)")
        .run(idx, type, pb([1, timestamp(createdAt)]), "secret user prompt"),
    gen: (idx: number, data: Uint8Array) =>
      db.query("INSERT OR REPLACE INTO gen_metadata (idx, data) VALUES (?, ?)").run(idx, data),
  };
}

const USER = 14;
const PLANNER = 15;

async function drain(state: ExtractState, opts: Partial<CollectOptions> = {}) {
  const events: TokenEvent[] = [];
  for await (const batch of collect(state, {
    enabled: new Set(["antigravity"]),
    dirs: { antigravity: [dir] },
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

/** Moves a file's time forward, as a write would. */
const touch = (path: string, ms: number) => utimesSync(path, new Date(ms), new Date(ms));

describe("Antigravity databases", () => {
  test("reads each call's usage and each user message, without their content", async () => {
    const c = conversation("cas-1");
    c.step(0, USER, 1_000);
    c.gen(
      0,
      call({
        step: 1,
        usage: usage({ input: 9662, output: 3526, thinking: 3183, response: 343, read: 8136, write: 12 }),
        model: "gemini-3.5-flash",
        startedAt: 1_100,
      }),
    );
    c.step(1, PLANNER, 1_050);
    c.step(2, PLANNER, 1_060);
    // No chat start time: the time of the call's first step. No model id: its display name.
    c.gen(1, call({ step: 2, usage: usage({ input: 10, output: 2 }), displayName: "Gemini 3.5 Flash" }));
    // Failed before the model answered: no usage.
    c.gen(2, call({ step: 3 }));
    // Older calls left `output` out; it is never less than thinking plus response.
    c.gen(3, call({ step: 3, usage: usage({ input: 5, thinking: 4, response: 3 }), startedAt: 1_200 }));
    c.db.close();

    const { events, state } = await drain({ files: {} });

    expect(events.map((e) => [e.messageId, e.messageType, e.model, e.timestamp])).toEqual([
      ["cas-1:step:0", "user", "", 1_000],
      ["cas-1:gen:1", "assistant", "Gemini 3.5 Flash", 1_060],
      ["cas-1:gen:0", "assistant", "gemini-3.5-flash", 1_100],
      ["cas-1:gen:3", "assistant", "unknown", 1_200],
    ]);
    expect(events[2]).toEqual({
      source: "antigravity",
      sessionId: "cas-1",
      agentId: null,
      messageId: "cas-1:gen:0",
      requestId: "resp-1",
      timestamp: 1_100,
      model: "gemini-3.5-flash",
      messageType: "assistant",
      inputTokens: 9662,
      outputTokens: 3526,
      cacheCreationTokens: 12,
      cacheReadTokens: 8136,
      reasoningTokens: 3183,
    });
    expect(events[3]!.outputTokens).toBe(7);
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(state.files[c.path]?.antigravity).toEqual({ generators: 4, steps: 3 });
  });

  test("reads only new rows, noticing a change that is still in the write-ahead log", async () => {
    const c = conversation("cas-1");
    c.db.exec("PRAGMA journal_mode = WAL");
    c.step(0, USER, 1_000);
    c.gen(0, call({ step: 1, usage: usage({ input: 1 }), startedAt: 1_000 }));
    const first = await drain({ files: {} });
    expect(first.events.map((e) => e.messageId)).toEqual(["cas-1:step:0", "cas-1:gen:0"]);
    expect((await drain(first.state)).events).toHaveLength(0);

    // Antigravity still has it open: the rows are in `-wal`, and the file's own time is unchanged.
    c.step(1, PLANNER, 2_000);
    c.step(2, USER, 3_000);
    c.gen(1, call({ step: 3, usage: usage({ input: 2 }), startedAt: 3_100 }));
    touch(c.path, 0);
    touch(`${c.path}-wal`, Date.now() + 5_000);
    const second = await drain(first.state);
    expect(second.events.map((e) => e.messageId)).toEqual(["cas-1:step:2", "cas-1:gen:1"]);
    c.db.close();
  });

  test("reads a closed database without writing anything beside it", async () => {
    const c = conversation("cas-1");
    c.db.exec("PRAGMA journal_mode = WAL");
    c.gen(0, call({ step: 1, usage: usage({ input: 1 }), startedAt: 1_000 }));
    // As when Antigravity closes it: the log folded back in, and `-wal` and `-shm` removed.
    c.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    c.db.close();
    for (const f of ["cas-1.db-wal", "cas-1.db-shm"]) rmSync(join(conversations, f), { force: true });
    expect(readdirSync(conversations)).toEqual(["cas-1.db"]);

    const { events } = await drain({ files: {} });

    expect(events.map((e) => e.messageId)).toEqual(["cas-1:gen:0"]);
    expect(readdirSync(conversations)).toEqual(["cas-1.db"]);
  });

  test("a conversation rewound to fewer rows is read again from the start", async () => {
    const c = conversation("cas-1");
    for (const idx of [0, 1, 2])
      c.gen(idx, call({ step: idx, usage: usage({ input: 1 }), startedAt: idx + 1 }));
    const first = await drain({ files: {} });
    c.db.exec("DELETE FROM gen_metadata WHERE idx > 0");
    c.gen(1, call({ step: 1, usage: usage({ input: 7 }), startedAt: 10 }));
    c.db.close();
    touch(c.path, Date.now() + 5_000);
    const second = await drain(first.state);
    expect(second.events.map((e) => [e.messageId, e.inputTokens])).toEqual([
      ["cas-1:gen:0", 1],
      ["cas-1:gen:1", 7],
    ]);
  });
});

describe("Antigravity's older encrypted conversations", () => {
  const pbPath = () => join(conversations, "cas-old.pb");

  beforeEach(() => {
    writeFileSync(pbPath(), "encrypted");
  });

  /** A server file for a process that is running: this one. */
  const daemon = (port = 4242, pid = process.pid) => {
    mkdirSync(join(dir, "daemon"), { recursive: true });
    writeFileSync(
      join(dir, "daemon", `hub_${port}.json`),
      JSON.stringify({ pid, httpPort: port, httpsPort: port - 1, csrfToken: "csrf-secret" }),
    );
  };

  const reply = (entries: unknown[]) => new Response(JSON.stringify({ generatorMetadata: entries }));
  const entry = (input: string) => ({
    stepIndices: [3],
    chatModel: {
      systemPrompt: "secret system prompt",
      usage: {
        model: "MODEL_PLACEHOLDER_M8",
        inputTokens: input,
        outputTokens: "3526",
        thinkingOutputTokens: "3183",
        responseOutputTokens: "343",
        cacheReadTokens: "8136",
      },
      chatStartMetadata: { createdAt: "2025-11-19T16:01:59.355049Z" },
    },
  });

  test("asks Antigravity's language server, from where the last read stopped", async () => {
    daemon();
    const asked: { url: string; headers: Headers; body: unknown }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      asked.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      return reply(asked.length === 1 ? [entry("9662")] : [entry("5")]);
    }) as unknown as typeof globalThis.fetch;

    const first = await parseAntigravityFile({ path: pbPath(), fileMtimeMs: 1, fetch });
    expect(first.events).toEqual([
      {
        source: "antigravity",
        sessionId: "cas-old",
        agentId: null,
        messageId: "cas-old:gen:0",
        requestId: null,
        timestamp: Date.parse("2025-11-19T16:01:59.355Z"),
        model: "MODEL_PLACEHOLDER_M8",
        messageType: "assistant",
        inputTokens: 9662,
        outputTokens: 3526,
        cacheCreationTokens: 0,
        cacheReadTokens: 8136,
        reasoningTokens: 3183,
      },
    ]);
    const second = await parseAntigravityFile({ path: pbPath(), prev: first.cursor!, fileMtimeMs: 1, fetch });
    expect(second.events.map((e) => e.messageId)).toEqual(["cas-old:gen:1"]);
    expect(second.cursor).toEqual({ generators: 2, steps: 0 });

    expect(asked[0]!.url).toBe(
      "http://127.0.0.1:4242/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata",
    );
    expect(asked[0]!.headers.get("X-Codeium-Csrf-Token")).toBe("csrf-secret");
    expect(asked.map((a) => a.body)).toEqual([
      { cascadeId: "cas-old", generatorMetadataOffset: 0 },
      { cascadeId: "cas-old", generatorMetadataOffset: 1 },
    ]);
    expect(JSON.stringify([first, second])).not.toContain("secret");
  });

  test("while Antigravity is closed, the file waits for a later read", async () => {
    // A server file left behind by a process that has exited.
    daemon(4242, 2 ** 22 + 1);
    const first = await drain({ files: {} });
    expect(first.events).toHaveLength(0);
    expect(first.state.files[pbPath()]).toEqual({ path: pbPath(), mtimeMs: 0, byteOffset: 0 });
    // Still unread: tried again on the next run, though the file has not changed.
    expect((await drain(first.state)).state.files[pbPath()]?.mtimeMs).toBe(0);
  });

  test("a server that can't be reached, or doesn't know the conversation, is not an error", async () => {
    daemon();
    const refused = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    expect(await parseAntigravityFile({ path: pbPath(), fileMtimeMs: 1, fetch: refused })).toEqual({
      events: [],
      cursor: null,
    });
    const unknown = (async () => new Response("{}", { status: 404 })) as unknown as typeof globalThis.fetch;
    expect(
      await parseAntigravityFile({
        path: pbPath(),
        fileMtimeMs: 1,
        fetch: unknown,
        prev: { generators: 3, steps: 0 },
      }),
    ).toEqual({ events: [], cursor: { generators: 3, steps: 0 } });
    const failing = (async () =>
      new Response("secret prompt", { status: 500 })) as unknown as typeof globalThis.fetch;
    const err = await parseAntigravityFile({ path: pbPath(), fileMtimeMs: 1, fetch: failing }).catch(
      (e) => e,
    );
    expect(String(err)).toBe("Error: Antigravity's language server answered 500.");
  });
});

test("lists each conversation once, preferring the database", async () => {
  process.env.ANTIGRAVITY_DATA_DIR = dir;
  process.env.ANTIGRAVITY_CLI_DATA_DIR = join(dir, "missing");
  expect(antigravityDir()).toBe(dir);
  for (const name of ["a.db", "a.pb", "b.pb", "c.db", "c.db-wal", "c.db-shm", "notes.txt"]) {
    writeFileSync(join(conversations, name), "");
  }
  expect(await listAntigravityFiles()).toEqual(["a.db", "b.pb", "c.db"].map((f) => join(conversations, f)));
  expect(await listAntigravityFiles(join(dir, "missing"))).toEqual([]);
});

test("lists the CLI's conversations beside the app's", async () => {
  const cli = join(dir, "cli");
  mkdirSync(join(cli, "conversations"), { recursive: true });
  writeFileSync(join(conversations, "a.db"), "");
  writeFileSync(join(cli, "conversations", "b.db"), "");
  process.env.ANTIGRAVITY_DATA_DIR = dir;
  process.env.ANTIGRAVITY_CLI_DATA_DIR = cli;
  expect(antigravityCliDir()).toBe(cli);
  expect(await listAntigravityFiles()).toEqual([
    join(conversations, "a.db"),
    join(cli, "conversations", "b.db"),
  ]);
  expect(await listAntigravityFiles(cli)).toEqual([join(cli, "conversations", "b.db")]);
});
