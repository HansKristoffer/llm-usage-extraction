import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CollectOptions, collect } from "../src/collect.ts";
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

async function drain(state: ExtractState, opts: CollectOptions = { enabled }) {
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
  process.env.POSTHOG_DESKTOP_DIR = join(dir, "posthog");
  await mkdir(join(dir, "claude", "projects", "p"), { recursive: true });
});

afterEach(async () => {
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.POSTHOG_DESKTOP_DIR;
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

test("dirs replace a source's default locations", async () => {
  await writeFile(join(dir, "claude", "projects", "p", "s1.jsonl"), line("m1"));
  const homes = [join(dir, "own"), join(dir, "private")];
  await Promise.all(homes.map((home) => mkdir(join(home, "p"), { recursive: true })));
  await writeFile(join(homes[0]!, "p", "a.jsonl"), line("m2"));
  await writeFile(join(homes[1]!, "p", "b.jsonl"), line("m3"));
  const { events } = await drain({ files: {} }, { enabled, dirs: { claude_code: homes } });
  expect(events.map((e) => e.messageId).sort()).toEqual(["m2", "m3"]);
});

test("a caller's seen set drops repeats across files", async () => {
  await writeFile(join(dir, "claude", "projects", "p", "s1.jsonl"), line("m1"));
  await writeFile(join(dir, "claude", "projects", "p", "s2.jsonl"), line("m1") + line("m2"));
  const hashes = new Set<number | bigint>();
  const seen = { has: (k: string) => hashes.has(Bun.hash(k)), add: (k: string) => hashes.add(Bun.hash(k)) };
  const { events } = await drain({ files: {} }, { enabled, seen });
  expect(events.map((e) => e.messageId).sort()).toEqual(["m1", "m2"]);
  expect(hashes.size).toBe(2);
});
