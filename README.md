# llm-usage-extraction

Reads token usage from the session logs that AI coding agents write on your machine. Shared by [tokenmaxxing](https://github.com/HansKristoffer/tokenmaxxing) and [agentgate](https://github.com/HansKristoffer/agentgate). Bun only.

| Source          | Where it reads                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `claude_code`   | `~/.claude/projects/**/*.jsonl` (`CLAUDE_CONFIG_DIR`) and PostHog Desktop's `<posthog>/claude/projects`                                                                              |
| `claude_cowork` | Claude Desktop's local agent sessions (`CLAUDE_COWORK_DIR`)                                                                                                                          |
| `codex`         | `~/.codex/sessions/` and `archived_sessions/` (`CODEX_HOME`), the rollouts listed in `state_*.sqlite` (`CODEX_SQLITE_HOME`), and PostHog Desktop's `<posthog>/codex-home/*/sessions` |
| `cursor_local`  | Cursor's `state.vscdb` (`CURSOR_DATA_DIR`) and agent transcripts (`CURSOR_PROJECTS_DIR`)                                                                                             |

App data lives in `~/Library/Application Support` on macOS, `%APPDATA%` on Windows and `$XDG_CONFIG_HOME` (or `~/.config`) on Linux. `<posthog>` is `@posthog/posthog-code` there, or `POSTHOG_DESKTOP_DIR`.

Each model turn becomes a `TokenEvent`: input, output, cache read, cache write and reasoning tokens, with session, message id, model and timestamp. Message content is never read into an event.

## Install

```sh
bun add llm-usage-extraction
```

## Use

`collect` reads every enabled source from where the last read stopped and yields batches. Commit a batch's state only after you have stored its events, so a failure re-reads them next time.

```ts
import { collect, type ExtractState } from "llm-usage-extraction";

let state: ExtractState = { files: {} };
for await (const batch of collect(state, { enabled: new Set(["claude_code", "codex"]) })) {
  await store(batch.events);
  state = batch.commit(state);
}
```

Persist `state` between runs to read only new lines. `dirs` reads only the given folders for a source instead of its default locations, for example `{ claude_code: [ownDir, otherDir] }`. `seen` replaces the set of message keys used to drop repeats within a run; a long-running process reading GBs of logs can pass a smaller one, such as `{ has: (k) => hashes.has(Bun.hash(k)), add: (k) => hashes.add(Bun.hash(k)) }`.

The parsers (`parseClaudeCodeFile`, `parseCodexFile`, `parseCursorTranscriptFile`, `parseCursorLocal`) and the file listers (`listClaudeCodeFiles(dir?)` and friends) are exported for callers that walk other directories. A lister given a `dir` reads only that folder; with none it reads every default location.

## What it handles

- Claude Code writes one line per content block with the same message id, and only the last has the final `output_tokens`. Each message counts once, with the last line's numbers. A message split across two reads arrives twice with the same ids; keep the larger numbers.
- Codex's `input_tokens` includes cached tokens; events report them separately. Replayed `token_count` lines and the parent history copied into forked or subagent rollouts are not counted again.
- Session logs of several GB are read in bounded windows, and a partly written last line is left for the next read.
