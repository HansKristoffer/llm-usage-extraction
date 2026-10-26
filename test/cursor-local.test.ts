import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_KV_TIMESTAMPS_SQL,
  COMPOSER_TIMESTAMPS_SQL,
  CURSOR_LOCAL_FALLBACK_MODEL,
  estimateContextCharLength,
  estimateCursorTokens,
  keyPrefixRange,
  messageTypeForBubble,
  parseCursorLocal,
  resolveCursorTimestamp,
} from "../src/cursor-local.ts";
import { cursorProjectsDir, cursorStateDbPath } from "../src/paths.ts";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeCursorDb(rows: Array<{ key: string; value: unknown }>): {
  dbPath: string;
  dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "cursor-local-test-"));
  tmpDirs.push(dir);
  const dbPath = join(dir, "state.vscdb");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  const insert = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES ($key, $value)");
  for (const row of rows) {
    insert.run({ $key: row.key, $value: JSON.stringify(row.value) });
  }
  db.close();
  utimesSync(dbPath, new Date(1_780_000_000_000), new Date(1_780_000_000_000));
  return { dbPath, dir };
}

describe("parseCursorLocal", () => {
  it("maps assistant bubbles with tokenCount and composer createdAt", () => {
    const composerId = "comp-1";
    const bubbleId = "bubble-1";
    const { dbPath } = makeCursorDb([
      {
        key: `composerData:${composerId}`,
        value: { createdAt: 1_700_000_000_000 },
      },
      {
        key: `bubbleId:${composerId}:${bubbleId}`,
        value: {
          type: 2,
          bubbleId,
          usageUuid: "usage-1",
          tokenCount: { inputTokens: 100, outputTokens: 25 },
          text: "assistant reply",
        },
      },
    ]);

    const r = parseCursorLocal({
      dbPath,
      lastRowid: 0,
      dbMtimeMs: 1_780_000_000_000,
    });
    expect(r.events.length).toBe(1);
    expect(r.events[0]).toEqual({
      source: "cursor_local",
      sessionId: composerId,
      agentId: null,
      messageId: bubbleId,
      requestId: "usage-1",
      timestamp: 1_700_000_000_000,
      model: CURSOR_LOCAL_FALLBACK_MODEL,
      messageType: "assistant",
      inputTokens: 100,
      outputTokens: 25,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: null,
    });
    expect(r.seenDedupKeys).toEqual(["bubble-1:usage-1"]);
    expect(r.newRowid).toBeGreaterThan(0);
  });

  it("falls back to lastUpdatedAt when createdAt is missing", () => {
    const composerId = "comp-lu";
    const { dbPath } = makeCursorDb([
      {
        key: `composerData:${composerId}`,
        value: { lastUpdatedAt: 1_780_500_000_000 },
      },
      {
        key: `bubbleId:${composerId}:b1`,
        value: {
          type: 2,
          bubbleId: "b1",
          usageUuid: "u1",
          tokenCount: { inputTokens: 1, outputTokens: 1 },
        },
      },
    ]);

    const r = parseCursorLocal({
      dbPath,
      lastRowid: 0,
      dbMtimeMs: 1_780_000_000_000,
    });
    expect(r.events[0]!.timestamp).toBe(1_780_500_000_000);
  });

  it("uses db mtime when composer metadata is missing (never 1970)", () => {
    const { dbPath } = makeCursorDb([
      {
        key: "bubbleId:comp-2:bubble-2",
        value: {
          type: 2,
          bubbleId: "bubble-2",
          usageUuid: "usage-2",
          tokenCount: { inputTokens: 0, outputTokens: 5 },
        },
      },
    ]);

    const r = parseCursorLocal({ dbPath, lastRowid: 0, dbMtimeMs: 1_780_000_000_000 });
    expect(r.events.length).toBe(1);
    expect(r.events[0]!.timestamp).toBe(1_780_000_000_000);
  });

  it("rounds fractional db mtime to an integer timestamp (server rejects floats)", () => {
    const { dbPath } = makeCursorDb([
      {
        key: "bubbleId:comp-3:bubble-3",
        value: {
          type: 2,
          bubbleId: "bubble-3",
          usageUuid: "usage-3",
          tokenCount: { inputTokens: 0, outputTokens: 5 },
        },
      },
    ]);

    const r = parseCursorLocal({
      dbPath,
      lastRowid: 0,
      dbMtimeMs: 1_780_000_000_000.6118,
    });
    expect(r.events.length).toBe(1);
    expect(Number.isInteger(r.events[0]!.timestamp)).toBe(true);
    expect(r.events[0]!.timestamp).toBe(1_780_000_000_001);
  });

  it("estimates assistant output tokens from text length when tokenCount is zero", () => {
    const composerId = "comp-2";
    const text = "abcd".repeat(10); // 40 chars → 10 tokens
    const { dbPath } = makeCursorDb([
      {
        key: `bubbleId:${composerId}:bubble-2`,
        value: {
          type: 2,
          bubbleId: "bubble-2",
          usageUuid: "usage-2",
          tokenCount: { inputTokens: 0, outputTokens: 0 },
          text,
        },
      },
    ]);

    const r = parseCursorLocal({ dbPath, lastRowid: 0, dbMtimeMs: 1_780_000_000_000 });
    expect(r.events.length).toBe(1);
    expect(r.events[0]!.outputTokens).toBe(10);
    expect(r.events[0]!.inputTokens).toBe(0);
  });

  it("estimates input tokens from attached code chunks", () => {
    const { dbPath } = makeCursorDb([
      {
        key: "bubbleId:comp-ctx:b1",
        value: {
          type: 2,
          bubbleId: "b1",
          usageUuid: "u-ctx",
          tokenCount: { inputTokens: 0, outputTokens: 0 },
          text: "ok",
          attachedCodeChunks: [{ lines: ["abcd", "efgh"] }],
        },
      },
    ]);

    const r = parseCursorLocal({ dbPath, lastRowid: 0, dbMtimeMs: 1_780_000_000_000 });
    expect(r.events[0]!.inputTokens).toBe(2);
    expect(r.events[0]!.outputTokens).toBe(1);
  });

  it("maps role=agent to assistant", () => {
    const { dbPath } = makeCursorDb([
      {
        key: "bubbleId:comp-role:b1",
        value: {
          role: "agent",
          bubbleId: "b1",
          usageUuid: "u-role",
          tokenCount: { inputTokens: 2, outputTokens: 3 },
        },
      },
    ]);

    const r = parseCursorLocal({ dbPath, lastRowid: 0, dbMtimeMs: 1_780_000_000_000 });
    expect(r.events[0]!.messageType).toBe("assistant");
  });

  it("emits zero-token user bubbles", () => {
    const { dbPath } = makeCursorDb([
      {
        key: "bubbleId:comp-3:user-bubble",
        value: {
          type: 1,
          bubbleId: "user-bubble",
          usageUuid: "usage-3",
          tokenCount: { inputTokens: 0, outputTokens: 0 },
          text: "hello",
        },
      },
    ]);

    const r = parseCursorLocal({
      dbPath,
      lastRowid: 0,
      dbMtimeMs: 1_780_000_000_000,
    });
    expect(r.events.length).toBe(1);
    expect(r.events[0]!.messageType).toBe("user");
    expect(r.events[0]!.inputTokens).toBe(0);
    expect(r.events[0]!.outputTokens).toBe(0);
    expect(r.events[0]!.model).toBe("");
  });

  it("respects lastRowid watermark and dedupes within a read", () => {
    const composerId = "comp-4";
    const { dbPath } = makeCursorDb([
      {
        key: `bubbleId:${composerId}:first`,
        value: {
          type: 2,
          bubbleId: "first",
          usageUuid: "u1",
          tokenCount: { inputTokens: 1, outputTokens: 1 },
        },
      },
      {
        key: `bubbleId:${composerId}:second`,
        value: {
          type: 2,
          bubbleId: "second",
          usageUuid: "u2",
          tokenCount: { inputTokens: 2, outputTokens: 2 },
        },
      },
    ]);

    const first = parseCursorLocal({
      dbPath,
      lastRowid: 0,
      batchLimit: 1,
      dbMtimeMs: 1_780_000_000_000,
    });
    expect(first.events.length).toBe(1);
    expect(first.events[0]!.messageId).toBe("first");

    const second = parseCursorLocal({
      dbPath,
      lastRowid: first.newRowid,
      dbMtimeMs: 1_780_000_000_000,
    });
    expect(second.events.length).toBe(1);
    expect(second.events[0]!.messageId).toBe("second");
  });

  it("returns empty result when the database is missing", () => {
    const r = parseCursorLocal({
      dbPath: join(tmpdir(), "missing-state.vscdb"),
      lastRowid: 0,
    });
    expect(r.events).toEqual([]);
    expect(r.newRowid).toBe(0);
  });
});

describe("timestamp lookups use the key index", () => {
  it("keyPrefixRange yields a half-open range covering exactly the prefix", () => {
    expect(keyPrefixRange("composerData:")).toEqual({ lo: "composerData:", hi: "composerData;" });
    expect(keyPrefixRange("agentKv:blob:")).toEqual({ lo: "agentKv:blob:", hi: "agentKv:blob;" });
  });

  it("composer and agentKv timestamp queries seek the unique key index, never SCAN", () => {
    const { dbPath } = makeCursorDb([{ key: "composerData:c", value: { createdAt: 1 } }]);
    const db = new Database(dbPath, { readonly: true });
    try {
      const composer = keyPrefixRange("composerData:");
      const agent = keyPrefixRange("agentKv:");
      const blob = keyPrefixRange("agentKv:blob:");
      const plans = [
        db.query(`EXPLAIN QUERY PLAN ${COMPOSER_TIMESTAMPS_SQL}`).all({ $lo: composer.lo, $hi: composer.hi }),
        db.query(`EXPLAIN QUERY PLAN ${AGENT_KV_TIMESTAMPS_SQL}`).all({
          $lo: agent.lo,
          $hi: agent.hi,
          $blobLo: blob.lo,
          $blobHi: blob.hi,
        }),
      ].map((rows) => (rows as Array<{ detail: string }>).map((r) => r.detail).join(" | "));
      for (const plan of plans) {
        expect(plan).toContain("USING INDEX");
        expect(plan).not.toContain("SCAN cursorDiskKV");
      }
    } finally {
      db.close();
    }
  });

  it("range bounds ignore keys outside the exact prefix, including the upper bound itself", () => {
    const composerId = "comp-range";
    const { dbPath } = makeCursorDb([
      { key: `composerdata:${composerId}`, value: { createdAt: 1_700_000_000_000 } },
      { key: `composerData;${composerId}`, value: { createdAt: 1_700_000_000_001 } },
      { key: `agentKv:blob:${composerId}:x`, value: { createdAt: 1_700_000_000_002 } },
      { key: `agentKv:${composerId}:x`, value: { lastUpdatedAt: 1_750_000_000_000 } },
      {
        key: `bubbleId:${composerId}:b1`,
        value: {
          type: 2,
          bubbleId: "b1",
          usageUuid: "u1",
          tokenCount: { inputTokens: 1, outputTokens: 1 },
        },
      },
    ]);
    const r = parseCursorLocal({
      dbPath,
      lastRowid: 0,
      dbMtimeMs: 1_780_000_000_000,
    });
    expect(r.events.length).toBe(1);
    expect(r.events[0]!.timestamp).toBe(1_750_000_000_000);
  });
});

describe("estimateCursorTokens", () => {
  it("does not estimate user messages", () => {
    expect(
      estimateCursorTokens(
        { type: 1, text: "hello world", tokenCount: { inputTokens: 0, outputTokens: 0 } },
        "user",
      ),
    ).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("counts attached context char length", () => {
    expect(
      estimateContextCharLength({
        attachedCodeChunks: [{ lines: ["abc", "de"] }],
        attachedFileCodeChunksUris: ["file:///tmp/foo.ts"],
      }),
    ).toBe(23);
  });
});

describe("resolveCursorTimestamp", () => {
  it("never returns 0", () => {
    const ts = resolveCursorTimestamp("missing", new Map(), new Map(), 0);
    expect(ts).toBeGreaterThan(0);
  });
});

describe("messageTypeForBubble", () => {
  it("accepts agent role", () => {
    expect(messageTypeForBubble({ role: "agent" })).toBe("assistant");
  });
});

describe("cursor path helpers", () => {
  it("cursorStateDbPath joins state.vscdb under globalStorage", () => {
    const prevData = process.env.CURSOR_DATA_DIR;
    const prevProjects = process.env.CURSOR_PROJECTS_DIR;
    process.env.CURSOR_DATA_DIR = "/tmp/cursor-global";
    process.env.CURSOR_PROJECTS_DIR = "/tmp/cursor-projects";
    expect(cursorStateDbPath()).toBe("/tmp/cursor-global/state.vscdb");
    expect(cursorProjectsDir()).toBe("/tmp/cursor-projects");
    if (prevData === undefined) delete process.env.CURSOR_DATA_DIR;
    else process.env.CURSOR_DATA_DIR = prevData;
    if (prevProjects === undefined) delete process.env.CURSOR_PROJECTS_DIR;
    else process.env.CURSOR_PROJECTS_DIR = prevProjects;
  });
});
