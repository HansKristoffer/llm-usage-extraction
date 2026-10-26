import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect } from "../src/collect.ts";
import type { ExtractState, Source, TokenEvent } from "../src/types.ts";

let dir: string;
const enabled = new Set<Source>(["claude_code"]);

const line = (id: string) =>
  `${JSON.stringify({
    type: "assistant",
    sessionId: "s1",
    timestamp: "2026-09-01T10:00:00.000Z",
    message: { id, model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 2 } },
  })}\n`;

async function drain(state: ExtractState, opts = { enabled }) {
  const events: TokenEvent[] = [];
  for await (const batch of collect(state, opts)) {
    events.push(...batch.events);
    state = batch.commit(state);
  }
  return { events, state };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lue-collect-"));
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
  await mkdir(join(dir, "claude", "projects", "p"), { recursive: true });
});

afterEach(async () => {
  delete process.env.CLAUDE_CONFIG_DIR;
  await rm(dir, { recursive: true, force: true });
});

test("resumes from the committed offset", async () => {
  const file = join(dir, "claude", "projects", "p", "s1.jsonl");
  await writeFile(file, line("m1") + line("m2"));
  const r1 = await drain({ files: {} });
  expect(r1.events.map((e) => e.messageId)).toEqual(["m1", "m2"]);

  await appendFile(file, line("m3"));
  await utimes(file, new Date(), new Date(Date.now() + 5000));
  const r2 = await drain(r1.state);
  expect(r2.events.map((e) => e.messageId)).toEqual(["m3"]);
});

test("an uncommitted batch is read again", async () => {
  await writeFile(join(dir, "claude", "projects", "p", "s1.jsonl"), line("m1"));
  for await (const _ of collect({ files: {} }, { enabled })) break;
  expect((await drain({ files: {} })).events).toHaveLength(1);
});

test("commit keeps the caller's own state fields", async () => {
  await writeFile(join(dir, "claude", "projects", "p", "s1.jsonl"), line("m1"));
  const { state } = await drain({ files: {}, lastSyncedAt: 1 } as ExtractState & { lastSyncedAt: number });
  expect((state as ExtractState & { lastSyncedAt: number }).lastSyncedAt).toBe(1);
});

test("disabled sources are skipped", async () => {
  await writeFile(join(dir, "claude", "projects", "p", "s1.jsonl"), line("m1"));
  expect((await drain({ files: {} }, { enabled: new Set() })).events).toHaveLength(0);
});
