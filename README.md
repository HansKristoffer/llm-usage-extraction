# llm-usage-extraction

Reads token usage from the session logs that AI coding agents write on your machine. Shared by [tokenmaxxing](https://github.com/HansKristoffer/tokenmaxxing) and [agentgate](https://github.com/HansKristoffer/agentgate). Bun only.

| Source          | Where it reads                                                                           |
| --------------- | ---------------------------------------------------------------------------------------- |
| `claude_code`   | `~/.claude/projects/**/*.jsonl` (`CLAUDE_CONFIG_DIR`)                                    |
| `claude_cowork` | Claude Desktop's local agent sessions (`CLAUDE_COWORK_DIR`)                              |
| `codex`         | `~/.codex/sessions/**/*.jsonl` (`CODEX_HOME`)                                            |
| `cursor_local`  | Cursor's `state.vscdb` (`CURSOR_DATA_DIR`) and agent transcripts (`CURSOR_PROJECTS_DIR`) |

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

Persist `state` between runs to read only new lines. The parsers (`parseClaudeCodeFile`, `parseCodexFile`, `parseCursorTranscriptFile`, `parseCursorLocal`) and the file listers (`listClaudeCodeFiles(dir?)` and friends) are exported for callers that walk other directories.

## What it handles

- Claude Code writes one line per content block, each repeating the message's usage. Each message counts once.
- Codex's `input_tokens` includes cached tokens; events report them separately. Replayed `token_count` lines and the parent history copied into forked or subagent rollouts are not counted again.
- Session logs of several GB are read in bounded windows, and a partly written last line is left for the next read.
