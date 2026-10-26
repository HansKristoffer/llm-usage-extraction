import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

function resolveDir(envValue: string | undefined, fallback: string): string {
  const raw = envValue && envValue.length > 0 ? envValue : fallback;
  const expanded = raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded);
}

const appSupport = () => join(homedir(), "Library", "Application Support");

export function claudeCodeProjectsDir(): string {
  // CLAUDE_CONFIG_DIR points at the .claude root; sessions live under projects/
  return join(resolveDir(process.env.CLAUDE_CONFIG_DIR, join(homedir(), ".claude")), "projects");
}

/** Claude Desktop's data dir, which holds Cowork ("local agent mode") transcripts. */
export function claudeCoworkDir(): string {
  return resolveDir(process.env.CLAUDE_COWORK_DIR, join(appSupport(), "Claude"));
}

export function codexSessionsDir(): string {
  return join(resolveDir(process.env.CODEX_HOME, join(homedir(), ".codex")), "sessions");
}

export function cursorStateDbPath(): string {
  const dir = resolveDir(process.env.CURSOR_DATA_DIR, join(appSupport(), "Cursor", "User", "globalStorage"));
  return join(dir, "state.vscdb");
}

export function cursorProjectsDir(): string {
  return resolveDir(process.env.CURSOR_PROJECTS_DIR, join(homedir(), ".cursor", "projects"));
}

// The Desktop store has used both names across versions; scan both.
const COWORK_SESSION_ROOTS = ["local-agent-mode-sessions", "claude-code-sessions"] as const;

async function scanGlob(cwd: string, pattern: string, dot = false): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const rel of new Bun.Glob(pattern).scan({ cwd, onlyFiles: true, dot })) {
      out.push(join(cwd, rel));
    }
  } catch {
    // dir missing
  }
  return out;
}

/** Includes `<session>/subagents/agent-*.jsonl`, so subagents are parsed too. */
export function listClaudeCodeFiles(dir = claudeCodeProjectsDir()): Promise<string[]> {
  return scanGlob(dir, "**/*.jsonl");
}

/** Scoped to the session roots so the scan never descends into the multi-GB `vm_bundles/`. */
export async function listClaudeCoworkFiles(base = claudeCoworkDir()): Promise<string[]> {
  const groups = await Promise.all(
    COWORK_SESSION_ROOTS.map((root) => scanGlob(join(base, root), "**/.claude/projects/**/*.jsonl", true)),
  );
  return groups.flat();
}

export function listCodexFiles(dir = codexSessionsDir()): Promise<string[]> {
  return scanGlob(dir, "**/*.jsonl");
}

export function listCursorTranscriptFiles(dir = cursorProjectsDir()): Promise<string[]> {
  return scanGlob(dir, "**/agent-transcripts/**/*.jsonl");
}
