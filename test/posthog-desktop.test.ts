import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listClaudeCodeFiles, listCodexFiles } from "../src/paths.ts";

const ENV = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "POSTHOG_DESKTOP_DIR"] as const;

afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

/** Write a file, creating parent dirs. */
async function put(path: string, body = "{}\n"): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, body);
}

describe("listClaudeCodeFiles (PostHog Desktop)", () => {
  it("includes sessions from PostHog Desktop's Claude config dir", async () => {
    const base = await mkdtemp(join(tmpdir(), "posthog-disco-"));
    const own = join(base, "claude", "projects", "-p", "a.jsonl");
    const posthog = join(base, "posthog", "claude", "projects", "-p", "b.jsonl");
    const subagent = join(base, "posthog", "claude", "projects", "-p", "b", "subagents", "agent-1.jsonl");
    await Promise.all([put(own), put(posthog), put(subagent)]);
    process.env.CLAUDE_CONFIG_DIR = join(base, "claude");
    process.env.POSTHOG_DESKTOP_DIR = join(base, "posthog");
    expect((await listClaudeCodeFiles()).sort()).toEqual([own, posthog, subagent].sort());
  });

  it("ignores the app's other JSONL files", async () => {
    const base = await mkdtemp(join(tmpdir(), "posthog-disco-"));
    await put(join(base, "posthog", "claude", "telemetry", "events.jsonl"));
    await put(join(base, "posthog", "sessions", "s1", "logs.jsonl"));
    process.env.CLAUDE_CONFIG_DIR = join(base, "claude");
    process.env.POSTHOG_DESKTOP_DIR = join(base, "posthog");
    expect(await listClaudeCodeFiles()).toEqual([]);
  });

  it("lists a dir once when CLAUDE_CONFIG_DIR points at PostHog Desktop's", async () => {
    const base = await mkdtemp(join(tmpdir(), "posthog-disco-"));
    const file = join(base, "posthog", "claude", "projects", "-p", "a.jsonl");
    await put(file);
    process.env.CLAUDE_CONFIG_DIR = join(base, "posthog", "claude");
    process.env.POSTHOG_DESKTOP_DIR = join(base, "posthog");
    expect(await listClaudeCodeFiles()).toEqual([file]);
  });
});

describe("listCodexFiles (PostHog Desktop)", () => {
  /** Codex paths come back resolved, and macOS's tmpdir is a symlink. */
  const tempDir = async () => realpath(await mkdtemp(join(tmpdir(), "posthog-disco-")));

  it("includes the sessions PostHog Desktop keeps in each task run's Codex home", async () => {
    const base = await tempDir();
    const own = join(base, "codex", "sessions", "2026", "10", "05", "rollout-a.jsonl");
    const run1 = join(
      base,
      "posthog",
      "codex-home",
      "run-1",
      "sessions",
      "2026",
      "10",
      "05",
      "rollout-b.jsonl",
    );
    const run2 = join(
      base,
      "posthog",
      "codex-home",
      "run-2",
      "sessions",
      "2026",
      "10",
      "06",
      "rollout-c.jsonl",
    );
    await Promise.all([put(own), put(run1), put(run2)]);
    process.env.CODEX_HOME = join(base, "codex");
    process.env.POSTHOG_DESKTOP_DIR = join(base, "posthog");
    expect((await listCodexFiles()).sort()).toEqual([own, run1, run2].sort());
  });

  it("ignores a task run's other JSONL files", async () => {
    const base = await tempDir();
    await put(join(base, "posthog", "codex-home", "run-1", "history.jsonl"));
    await put(join(base, "posthog", "codex-home", "run-1", "skills", "x", "notes.jsonl"));
    process.env.CODEX_HOME = join(base, "codex");
    process.env.POSTHOG_DESKTOP_DIR = join(base, "posthog");
    expect(await listCodexFiles()).toEqual([]);
  });
});
