# llm-kb

Drop files into a folder. Get a knowledge base you can query — with a self-improving wiki that gets smarter every time you ask.

Inspired by [Karpathy's LLM Knowledge Bases](https://x.com/karpathy/status/2039805659525644595) and [Farzapedia](https://x.com/FarzaTV).

## Quick Start

```bash
npm install -g llm-kb
llm-kb run ./my-documents
```

That's it. PDFs get parsed, an index is built, and an interactive chat opens — ready for questions.

## Authentication

Two options (you need one):

**Option 1 — Pi SDK (recommended)**
```bash
npm install -g @mariozechner/pi-coding-agent
pi   # run once to authenticate
```

**Option 2 — Anthropic API key**
```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

If neither is configured, `llm-kb` shows a clear error with setup instructions.

## What It Does

### Run — scan, parse, index, chat

```bash
llm-kb run ./my-documents
```

```
llm-kb v0.5.0

Scanning ./my-documents...
  Found 9 files (9 PDF)
  9 parsed

  Building index... (claude-haiku-4-5)
  Index built: .llm-kb/wiki/index.md

Ready. Ask a question or drop files in to re-index.

────────────────────────────────────────────
> What are the key findings?
────────────────────────────────────────────

⟡ claude-sonnet-4-6

▸ Thinking
  Let me check the relevant source files...

  ▸ Reading  q3-report.md
  ▸ Reading  q4-report.md

──────────────────────────────────────────────

## Key Findings
Revenue grew 12% QoQ driven by...
(cited answer with page references)

── 8.3s · 2 files read ──────────────────────
```

**What happens:**
1. **Scans** — finds all supported files (PDF, DOCX, XLSX, PPTX, MD, TXT, CSV, images)
2. **Parses** — PDFs converted to markdown + bounding boxes via [LiteParse](https://github.com/run-llama/liteparse)
3. **Indexes** — Haiku reads sources, writes `index.md` with summary table
4. **Watches** — drop new files while running, they get parsed and indexed automatically
5. **Chat** — interactive TUI with Pi-style markdown rendering, thinking display, tool call progress
6. **Learns** — every answer updates a concept-organized wiki; repeated questions answered instantly from cache

### Continuous conversation

The chat maintains full conversation history. Follow-up questions work naturally:

```
> What is BNS 2023?
(detailed answer)

> Tell me more about the mob lynching clause
(agent remembers context — answers about Clause 101 without re-reading)

> How does that compare to the old IPC?
(continues the thread with full context)
```

Sessions persist across restarts — run `llm-kb run` again and the conversation continues.

### Query — single question from CLI

```bash
llm-kb query "compare Q3 vs Q4"
llm-kb query "summarize revenue data" --folder ./my-documents
llm-kb query "full analysis of lease terms" --save  # research mode
```

### Eval — analyze and improve

```bash
llm-kb eval
llm-kb eval --last 10
```

```
llm-kb eval

  Reading sessions...
  Found 29 Q&A exchanges across sessions
  Judging 1/29: "What are the 2023 new laws?"
  ...
  Judging 29/29: "How many files you have"

  Results:
  Queries analyzed:  29
  Wiki hit rate:     66%
  Wasted reads:      42
  Issues:            22 errors  24 warnings
  Wiki gaps:         28

  Report: .llm-kb/wiki/outputs/eval-report.md
```

Eval reads your session files and uses Haiku as a judge to find:

| Check | What it catches |
|---|---|
| **Citation validity** | Agent claims "Clause 303" but source says "Clause 304" |
| **Contradictions** | Answer says "sedition retained" but source says "removed" |
| **Wiki gaps** | Topics asked 4 times but never cached in wiki |
| **Wasted reads** | Files read but never cited in the answer |
| **Performance** | Wiki hit rate, avg duration, most-read files |

The eval report includes actionable recommendations and updates `.llm-kb/guidelines.md` — learned rules the agent reads on-demand during queries. You can also add your own rules to this file (see [Guidelines](#guidelines) below).

### Status — KB overview

```bash
llm-kb status
```

```
Knowledge Base Status
  Folder:  /path/to/my-documents
  Sources: 12 parsed sources
  Index:   3 min ago
  Articles: 15 compiled
  Outputs: 2 saved answers
  Models:  claude-sonnet-4-6 (query)  claude-haiku-4-5 (index)
  Auth:    Pi SDK
```

## The Three-Layer Architecture

The system separates **how to behave**, **what to know**, and **what went wrong** into three files with distinct lifecycles:

```
┌──────────────────────────────────────────────────────────────┐
│  AGENTS.md (runtime — built by code, not on disk)        │
│  How to answer: source list, tool patterns, citation     │
│  rules. Points to guidelines.md for learned behaviour.   │
└──────────────────────────────────────────────────────────────┘
                              │
            ┌─────────────────┴─────────────────┐
            ▼                                   ▼
┌────────────────────────────┐  ┌────────────────────────────┐
│  wiki.md                     │  │  guidelines.md              │
│  WHAT to know                │  │  HOW to behave better       │
│                              │  │                              │
│  Concept-organized knowledge │  │  Eval insights (auto)       │
│  synthesized from sources.   │  │  + your custom rules.       │
│  Updated after every query.  │  │  Read on-demand by agent.   │
└────────────────────────────┘  └────────────────────────────┘
       ▲                                    ▲
       │ updated by wiki-updater             │ updated by eval
       │                                      │
┌──────┴─────────────────────────────────────────┴────────┐
│  llm-kb eval                                              │
│  Reads sessions → judges quality → updates guidelines.md  │
│  + writes eval-report.md for humans                       │
└──────────────────────────────────────────────────────────────┘
```

| Layer | File | Changes when | Written by |
|---|---|---|---|
| Architecture | AGENTS.md (runtime) | Code deploys | Developer |
| Behaviour | `guidelines.md` | After eval / by you | Eval + user |
| Knowledge | `wiki.md` | After every query | Wiki updater |

The agent sees AGENTS.md in its system prompt (lean, stable). It reads `guidelines.md` and `wiki.md` on-demand via tool calls — progressive disclosure, not context bloat.

## The Data Flywheel

Every query makes the system faster. Every eval makes it smarter.

```
       ┌─────────────────┐
       │  User asks       │
       │  a question      │
       └────────┬────────┘
                │
                ▼
   ┌────────────────────────┐
   │  Agent checks wiki.md    │
   │  + reads guidelines.md   │ ◄── on-demand, not forced
   │  + reads source files     │
   └────────────┬───────────┘
                │
                ▼
   ┌────────────────────────┐
   │  Wiki updated          │ ◄── knowledge compounds
   │  (concept-organized)   │
   └────────────┬───────────┘
                │
                ▼
   ┌────────────────────────┐
   │  Next similar query    │
   │  answered from wiki    │ ── 0 file reads, 2s instead of 25s
   └────────────┬───────────┘
                │
                ▼
   ┌────────────────────────┐
   │  llm-kb eval           │ ◄── behaviour compounds
   │  analyzes sessions     │     updates guidelines.md
   │  improves behaviour    │     with learned rules
   └────────────────────────┘
```

**Proven results:**
- First query about a topic: ~25s, reads source files
- Same question again: ~2s, answered from wiki, 0 files read
- Wiki hit rate grows with usage: 0% → 66% after 29 queries

## The Concept Wiki

The wiki organizes knowledge by **concepts**, not source files. A single wiki entry can synthesize information from multiple sources:

```markdown
## Mob Lynching
First-ever criminalisation in Indian law under BNS 2023, Clause 101(2).
Group of 5+ persons, discriminatory grounds, minimum 7 years to death.
IPC had no equivalent — prosecuted under general S.302.
See also: [[Murder and Homicide]], [[BNS 2023 Overview]]
*Sources: indian penal code - new.md (p.137), Annotated comparison (p.15) · 2026-04-06*

---

## Electronic Evidence
Section 65B requires certificate from responsible official.
BSB 2023 expands: emails, WhatsApp, GPS, cloud docs all admissible.
See also: [[Evidence Law Overview]]
*Sources: Indian Evidence Act.md, Comparison Chart.md · 2026-04-06*
```

## Model Configuration

Auto-generated at `.llm-kb/config.json`:

```json
{
  "indexModel": "claude-haiku-4-5",
  "queryModel": "claude-sonnet-4-6"
}
```

| Task | Model | Why |
|---|---|---|
| Index | Haiku | Summarizing sources — cheap, fast |
| Wiki update | Haiku | Merging knowledge — cheap, fast |
| Eval judge | Haiku | Checking quality — cheap, fast |
| Query | Sonnet | Complex reasoning, citations — needs strength |

Override with env vars:
```bash
LLM_KB_INDEX_MODEL=claude-haiku-4-5 llm-kb run ./docs
LLM_KB_QUERY_MODEL=claude-sonnet-4-6 llm-kb query "question"
```

## Non-PDF Files

PDFs are parsed at scan time. Other file types are read dynamically by the agent using bash scripts:

| File type | How it's read |
|---|---|
| `.pdf` | Pre-parsed to markdown + bounding boxes (LiteParse) |
| `.docx` | Selective XML reading via `adm-zip` (structure first, then relevant sections) |
| `.xlsx` | Specific sheets/cells via `exceljs` |
| `.pptx` | Text extraction via `officeparser` |
| `.md`, `.txt`, `.csv` | Read directly |

For large files, the agent reads the structure first, then extracts only the sections relevant to the question — never dumps the entire file.

## OCR for Scanned PDFs

Most PDFs have native text. For scanned PDFs:

```bash
OCR_ENABLED=true llm-kb run ./docs                              # local Tesseract
OCR_SERVER_URL="http://localhost:8080/ocr?key=KEY" llm-kb run .  # remote Azure OCR
```

## Guidelines

`guidelines.md` is the agent’s learned behaviour file. Eval writes the `## Eval Insights` section automatically. You can add your own rules below it — eval will never overwrite them.

```markdown
## Eval Insights (auto-generated 2026-04-07)

### Wiki Gaps — add to wiki when users ask about these topics
- Reserve requirements
- Engine types

### Behaviour Fixes
- Double-check clause numbers against source text.

### Performance
- Wiki hit rate: 82% (target: 80%+)
- Avg query time: 3.1s

## My Rules

- Always use Hindi transliterations for legal terms
- Respond in bullet points for legal questions
- For aviation leases: always check both lessee and lessor obligations
```

The agent reads this file on-demand — not on every query. It consults guidelines when unsure about citation accuracy, file selection, or when a question touches a topic that had issues before. This keeps the system prompt lean while making learned behaviour available when it matters.

You can create `guidelines.md` manually before ever running eval. The agent will find it.

## What It Creates

```
./my-documents/
├── (your files — untouched)
└── .llm-kb/
    ├── config.json           ← model configuration
    ├── guidelines.md         ← learned rules from eval + your custom rules
    ├── sessions/             ← conversation history (JSONL)
    ├── traces/               ← per-query traces (JSON)
    │   └── .processed        ← prevents re-processing on restart
    └── wiki/
        ├── index.md          ← source summary table
        ├── wiki.md           ← concept-organized knowledge wiki
        ├── queries.md        ← query log (newest first)
        ├── sources/          ← parsed markdown + bounding boxes
        └── outputs/
            ├── eval-report.md  ← eval analysis report
            └── ...             ← saved research answers (--save)
```

Your original files are never modified. Delete `.llm-kb/` to start fresh.

## Display

The interactive TUI (via `@mariozechner/pi-tui`) shows the Claude Web UI pattern:

| Phase | What you see |
|---|---|
| Model | `⟡ claude-sonnet-4-6` |
| Thinking | `▸ Thinking` + streamed reasoning (dim) |
| Tool calls | `▸ Reading file.md` / `▸ Running bash` + code block |
| Answer | Separator line → markdown with tables, code blocks, headers |
| Done | `── 8.3s · 2 files read ──` |

Phases can interleave: think → read files → answer → think again → read more → continue answer.

The `llm-kb query` command uses stdout mode — same phases, works with pipes and scripts.

## Development

```bash
git clone https://github.com/satish860/llm-kb
cd llm-kb
npm install
npm run build
npm link

npm test              # 42 tests
npm run test:watch    # vitest watch mode

llm-kb run ./test-folder
```

## Tutorial

Building this in public: [themindfulai.dev](https://themindfulai.dev/articles/building-karpathy-knowledge-base-part-1)

## License

MIT — [Satish Venkatakrishnan](https://deltaxy.ai)
