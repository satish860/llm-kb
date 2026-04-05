# llm-kb — Phase 3: Auth Fix + Eval Loop + LLM Config

> **Priority 1:** Auth fix — users are bouncing because Pi isn't configured
> **Priority 2:** Eval loop — the differentiator nobody else has
> **Priority 3:** LLM config — let users pick models
> **Blog:** Part 4 of the series (eval loop)

---

## 1. Auth Fix (URGENT)

Users run `npx llm-kb run` and hit a wall because Pi SDK isn't installed or configured. 117 people saved the LinkedIn post — they're coming back soon.

### The Flow

```
User runs `npx llm-kb run ./docs`
  │
  ├─ Pi SDK auth exists (~/.pi/agent/auth.json)?
  │    → Use it. Done.
  │
  ├─ ANTHROPIC_API_KEY env var set?
  │    → Configure Pi SDK programmatically. Done.
  │
  └─ Neither?
       → Show clear error:
       
       No LLM authentication found.

       Option 1: Install Pi SDK (recommended)
         npm install -g @mariozechner/pi-coding-agent
         pi

       Option 2: Set your Anthropic API key
         export ANTHROPIC_API_KEY=sk-ant-...
```

### Implementation

Check auth before creating any session. Add to `cli.ts` or a new `auth.ts`:

```typescript
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function checkAuth(): { ok: boolean; method: string } {
  // Check Pi SDK auth
  const piAuthPath = join(homedir(), ".pi", "agent", "auth.json");
  if (existsSync(piAuthPath)) {
    return { ok: true, method: "pi-sdk" };
  }

  // Check ANTHROPIC_API_KEY
  if (process.env.ANTHROPIC_API_KEY) {
    return { ok: true, method: "api-key" };
  }

  return { ok: false, method: "none" };
}
```

If method is `"api-key"`, configure Pi SDK's settings programmatically so `createAgentSession` works with the env var.

### Definition of Done
- [ ] `ANTHROPIC_API_KEY=sk-... npx llm-kb run ./docs` works without Pi installed
- [ ] Pi SDK auth works as before (no regression)
- [ ] Clear error message when neither is available
- [ ] README updated with both auth options

---

## 2. LLM Configuration

### Config File

Auto-generated on first run at `.llm-kb/config.json`:

```json
{
  "indexModel": "claude-haiku-3-5",
  "queryModel": "claude-sonnet-4-20250514",
  "provider": "anthropic"
}
```

### Env Var Overrides

```bash
LLM_KB_INDEX_MODEL=claude-haiku-3-5 llm-kb run ./docs
LLM_KB_QUERY_MODEL=claude-sonnet-4-20250514 llm-kb query "question"
```

### Priority

```
1. Env var (LLM_KB_INDEX_MODEL, LLM_KB_QUERY_MODEL)
2. Config file (.llm-kb/config.json)
3. Defaults (Haiku for indexing, Sonnet for query)
```

### Why This Matters

- Haiku for indexing is 10x cheaper than Sonnet — users shouldn't pay Sonnet prices for one-line summaries
- Some users want GPT or local models — provider config enables that later
- Config file is portable — `.llm-kb/` travels with the documents

### Definition of Done
- [ ] `config.json` auto-generated on first run
- [ ] Index uses cheap model (Haiku), query uses strong model (Sonnet) by default
- [ ] Env vars override config file
- [ ] `llm-kb status` shows current model config

---

## 3. Eval Loop

### What Gets Traced

Every query logs a JSON file to `.llm-kb/traces/`:

```json
{
  "id": "2026-04-06T14-30-00-query",
  "timestamp": "2026-04-06T14:30:00Z",
  "question": "what are the reserve requirements?",
  "mode": "query",
  "filesRead": ["index.md", "reserve-policy.md", "q3-results.md"],
  "filesAvailable": ["reserve-policy.md", "q3-results.md", "board-deck.md", "pipeline.md"],
  "filesSkipped": ["board-deck.md", "pipeline.md"],
  "answer": "Reserve requirements are defined in two documents...",
  "citations": [
    { "file": "reserve-policy.md", "location": "p.3", "claim": "Minimum reserve ratio of 12%" },
    { "file": "q3-results.md", "location": "p.8", "claim": "Current reserve ratio is 14.2%" }
  ],
  "durationMs": 4200
}
```

### How to Capture Traces

Wrap the session to intercept tool calls:

```typescript
// Track which files the agent reads
const filesRead: string[] = [];

session.subscribe((event) => {
  if (event.type === "tool_use") {
    // Check if it's a read tool call on a source file
    const path = extractPathFromToolCall(event);
    if (path && !filesRead.includes(path)) {
      filesRead.push(path);
    }
  }
});
```

After session completes, write the trace JSON.

### The Eval Command

```bash
llm-kb eval --folder ./research
llm-kb eval --folder ./research --last 20  # only check last 20 queries
```

The eval agent is a Pi SDK session (read-only) that:

1. Reads trace files from `.llm-kb/traces/`
2. For each trace, checks:
   - **Citation validity** — does the cited file contain the claimed text?
   - **Missing sources** — were any skipped files actually relevant?
   - **Answer consistency** — does the answer contradict the cited sources?
3. Writes report to `.llm-kb/wiki/outputs/eval-report.md`
4. Watcher detects the report, re-indexes

### The Eval AGENTS.md

```markdown
# llm-kb Knowledge Base — Eval Mode

## Your job
Read query traces from .llm-kb/traces/ and check answer quality.

## For each trace, check:
1. Citation validity — read the cited source file. Does it actually 
   contain the claimed text at the claimed location?
2. Missing sources — read the index summary for each skipped file. 
   Given the question, should any skipped file have been read?
3. Consistency — does the answer contradict anything in the 
   cited sources?

## Output
Write .llm-kb/wiki/outputs/eval-report.md with:
- Summary: X traces checked, Y issues found
- Per-trace findings (only flag issues, skip clean traces)
- Recommendations (e.g., "update summary for file X")
```

### Status Command

```bash
llm-kb status --folder ./research
```

```
Knowledge Base: ./research/.llm-kb/
  Sources: 12 files (8 PDF, 2 XLSX, 1 DOCX, 1 TXT)
  Index: 12 entries, last updated 2 min ago
  Outputs: 3 saved research answers
  Traces: 47 queries logged
  Model: claude-sonnet-4 (query), claude-haiku-3-5 (index)
  Auth: Pi SDK
```

---

## Build Order (Slices)

| Slice | What | Urgency |
|---|---|---|
| 1 | Auth check + ANTHROPIC_API_KEY fallback | 🔴 NOW — users bouncing |
| 2 | Config file (model selection) | 🟡 This week |
| 3 | Trace logging (JSON per query) | 🟡 This week |
| 4 | `status` command | 🟢 Nice to have |
| 5 | `eval` command + eval session | 🟡 This week |
| 6 | Blog Part 4 (eval loop) | After code works |

---

## Definition of Done (Full Phase 3)

- [ ] `ANTHROPIC_API_KEY` works without Pi SDK installed
- [ ] Clear error when no auth found
- [ ] Config file with model selection (index vs query model)
- [ ] Every query logs a trace to `.llm-kb/traces/`
- [ ] `llm-kb eval` checks citations and writes report
- [ ] `llm-kb status` shows KB stats + config
- [ ] README updated with auth options + eval command
- [ ] Blog Part 4 written with real eval output

---

*Phase 3 spec written April 5, 2026. DeltaXY.*
