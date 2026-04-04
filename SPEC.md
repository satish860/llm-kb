# llm-kb — Product Spec

> **One-liner:** Drop files into a folder. Get a knowledge base you can query.
> **npm:** `npx llm-kb run ./my-documents`
> **Status:** Part 2 of blog series. Ingest pipeline + CLI.

---

## Who Is This For

A developer or technical researcher who has 20-200 documents (PDFs, spreadsheets, slide decks, notes) scattered across folders. They want to ask questions across all of them without building a RAG pipeline or setting up a vector database.

**They will try this if:** it works in under 2 minutes with one command.
**They will keep using it if:** the answers are good and the wiki compounds over time.
**They will abandon it if:** setup is painful, it eats tokens without useful results, or it feels like a demo.

---

## What Success Looks Like

```bash
npx llm-kb run ./research
```

Terminal output:
```
llm-kb v0.1.0

Scanning ./research...
  Found 12 files (8 PDF, 2 XLSX, 1 DOCX, 1 TXT)
  Parsing... ████████████ 12/12
  Index built: 12 sources, 47K words

Open http://localhost:3000
  or query from terminal: llm-kb query "what are the key findings?"
```

Browser opens. Chat UI. Drop more files in while it's running. They get ingested automatically.

**That's the whole first-run experience.** No config file. No API key prompt during setup (read from env). No Docker. Just point at a folder.

---

## Commands

### `llm-kb run <folder>`

The main command. Does everything:

1. Scans the folder for supported files
2. Parses each file to markdown (+ JSON with bounding boxes for PDFs/images)
3. Builds `index.md` from all parsed sources
4. Starts a file watcher on the folder (new files get auto-ingested)
5. Starts a web server with chat UI at `http://localhost:3000`
6. Opens the browser

```bash
npx llm-kb run ./my-documents
npx llm-kb run ./my-documents --port 4000
npx llm-kb run ./my-documents --no-open          # don't open browser
npx llm-kb run ./my-documents --watch-only        # no web server, just watch + ingest
```

**Data layout it creates inside the folder:**

```
./my-documents/
├── (your original files — untouched)
├── .llm-kb/
│   ├── wiki/
│   │   ├── index.md
│   │   ├── sources/
│   │   │   ├── report.md
│   │   │   ├── report.json      ← bounding boxes
│   │   │   └── data.md
│   │   └── outputs/
│   │       └── (saved research answers)
│   ├── traces/
│   │   └── (query logs)
│   └── config.json              ← auto-generated, editable
```

**Key decision:** `.llm-kb/` lives inside the user's folder, not in a global location. The knowledge base is co-located with the documents. Delete the folder, delete the KB. Copy the folder to another machine, the KB comes with it.

### `llm-kb query <question>`

Query from the terminal without starting the web UI:

```bash
llm-kb query "what are the reserve requirements?" --folder ./research
llm-kb query "compare Q3 vs Q4 guidance" --folder ./research --save  # saves to outputs/
```

**Why this matters:** power users want terminal, not browser. Also enables scripting — pipe questions in, get answers out.

### `llm-kb ingest <file-or-folder>`

Parse files without starting the server:

```bash
llm-kb ingest ./new-report.pdf --folder ./research
llm-kb ingest ./batch-of-docs/ --folder ./research
```

Useful for adding files from a different location without copying them into the watched folder.

### `llm-kb status`

Show what's in the knowledge base:

```bash
llm-kb status --folder ./research
```

```
Knowledge Base: ./research/.llm-kb/
  Sources: 12 files (8 PDF, 2 XLSX, 1 DOCX, 1 TXT)
  Index: 12 entries, last updated 2 min ago
  Outputs: 3 saved research answers
  Traces: 47 queries logged
  Total words: ~47,000
```

### `llm-kb eval`

Run the eval loop manually:

```bash
llm-kb eval --folder ./research --last 20
```

Checks the last 20 query traces against sources. Writes eval report to `.llm-kb/wiki/outputs/eval-report.md`.

---

## Supported File Types

| Extension | Parser | Output | Bounding Boxes |
|---|---|---|---|
| `.pdf` | LiteParse | `.md` + `.json` | ✅ Yes |
| `.xlsx` / `.xls` | ExcelJS | `.md` (tables as markdown) | No |
| `.docx` | Mammoth | `.md` | No |
| `.pptx` | OfficeParser | `.md` (text per slide) | No |
| `.jpg` / `.png` | Sharp + OCR | `.md` + `.json` | ✅ Yes |
| `.txt` / `.md` | Copy | `.md` | No |
| `.csv` | Built-in | `.md` (as table) | No |

**Unsupported files are ignored** with a warning in the terminal. No crash.

---

## Configuration

Auto-generated on first run at `.llm-kb/config.json`. Editable by user.

```json
{
  "model": "claude-sonnet-4-20250514",
  "thinkingLevel": "low",
  "indexModel": "claude-haiku-3-5",
  "port": 3000,
  "ocrServerUrl": null,
  "maxFileSizeMb": 50,
  "ignorePatterns": ["node_modules", ".git", "*.lock"]
}

```

**Key decisions:**
- `model` — strong model for Q&A. Default: Sonnet.
- `indexModel` — cheap model for indexing (just summarizing). Default: Haiku.
- `ocrServerUrl` — optional Azure OCR bridge for scanned PDFs. Null = use built-in Tesseract.
- `ignorePatterns` — don't try to parse `node_modules` or lock files.
- **API key is NOT in config.** Read from `ANTHROPIC_API_KEY` env var. Never written to disk by the tool.

---

## API Key Handling

```
Priority:
1. ANTHROPIC_API_KEY env var
2. Pi SDK auth storage (~/.pi/agent/auth.json — if user has Pi installed)
3. Prompt: "Enter your Anthropic API key:" (first run only, saved to Pi auth storage)
```

**No key in config.json. No key in .llm-kb/. No key committed to git.**

If no key is found and no prompt is possible (non-interactive mode), exit with a clear error:

```
Error: No API key found.
Set ANTHROPIC_API_KEY environment variable or run interactively to enter it.
```

---

## Web UI

Minimal. Four panels:

```
┌───────────────┬────────────────────────────────────┐
│               │                                    │
│  Sources      │         Chat                       │
│  (file list)  │                                    │
│               │  > What changed in Q4 guidance?    │
│  ▸ report.pdf │                                    │
│  ▸ data.xlsx  │  Agent: Based on report.md...      │
│  ▸ deck.pptx  │                                    │
│               │  [Sources: report.md p.4,           │
│  Outputs      │   deck.md slide 6]                 │
│  ▸ compare.md │                                    │
│               ├────────────────────────────────────┤
│  Activity     │  [Query] [Research] [Lint] [Eval]  │
│  ✓ parsed 3   │                                    │
│  ✓ indexed    │  Drop files here to add            │
│               │                                    │
└───────────────┴────────────────────────────────────┘
```

**Built with:** Next.js App Router + Vercel AI SDK streaming. Forked directly from [HerculesV2](https://github.com/satish860/HerculesV2). We take:

- `app/api/chat/route.ts` — Pi SDK session management, Vercel AI streaming protocol, secret scrubbing, TTL cleanup
- `lib/store.ts` — session store with `globalThis` for hot reload survival
- `components.json` + Tailwind setup — shadcn/ui base
- `Dockerfile` — multi-stage build with `data/` volume

We remove: Salesforce integration, aviation skills, cron jobs, agent marketplace. We add: file upload drop zone, sources sidebar, activity feed, mode switching (query/research/lint/eval).

**Modes:**
- **Query** — read-only. Answer in chat.
- **Research** — read + write. Answer AND save to `outputs/`.
- **Lint** — check wiki for inconsistencies.
- **Eval** — run eval on recent traces.

**Drag-and-drop:** Drop files onto the UI. They get copied to the watched folder. Watcher picks them up. Same pipeline.

---

## Tech Stack

```
TypeScript (strict)
├── CLI: Commander
├── File watching: chokidar
├── Parsing:
│   ├── PDF: @llamaindex/liteparse
│   ├── Excel: exceljs
│   ├── Word: mammoth
│   ├── PowerPoint: officeparser
│   ├── Images: sharp
│   └── CSV: built-in
├── Agent: @mariozechner/pi-coding-agent (createAgentSession)
├── Web: Next.js 15 + Vercel AI SDK
└── No database. No vector store. Files only.
```

---

## Project Structure

```
llm-kb/
├── bin/
│   └── cli.ts                 ← Entry point (Commander)
├── src/
│   ├── ingest/
│   │   ├── watcher.ts         ← chokidar file watcher
│   │   ├── router.ts          ← file extension → parser adapter
│   │   ├── adapters/
│   │   │   ├── pdf.ts         ← LiteParse
│   │   │   ├── excel.ts       ← ExcelJS
│   │   │   ├── word.ts        ← Mammoth
│   │   │   ├── powerpoint.ts  ← OfficeParser
│   │   │   ├── image.ts       ← Sharp + OCR
│   │   │   ├── csv.ts         ← built-in
│   │   │   └── text.ts        ← copy
│   │   └── indexer.ts         ← Pi SDK session → writes index.md
│   ├── agent/
│   │   ├── sessions.ts        ← createAgentSession configs
│   │   ├── query.ts           ← read-only session
│   │   ├── research.ts        ← coding session (writes outputs)
│   │   └── eval.ts            ← eval session (reads traces)
│   ├── server/
│   │   └── index.ts           ← Express or Next.js dev server
│   ├── trace/
│   │   └── logger.ts          ← writes trace JSON per query
│   └── config.ts              ← reads/writes .llm-kb/config.json
├── app/                       ← Next.js UI (if bundled)
│   ├── page.tsx
│   ├── api/
│   │   ├── chat/route.ts      ← Pi SDK streaming (from HerculesV2)
│   │   └── status/route.ts
│   └── components/
│       ├── chat.tsx
│       ├── sources.tsx
│       ├── activity.tsx
│       └── upload.tsx
├── AGENTS.md                  ← Default wiki context for the agent
├── package.json
├── tsconfig.json
└── SPEC.md                    ← This file
```

---

## Constraints

1. **Zero config for first run.** `npx llm-kb run ./folder` must work with just an API key in env. No config file needed. No init step.

2. **No global state.** Everything lives in `.llm-kb/` inside the user's folder. Two different folders = two independent knowledge bases. No cross-contamination.

3. **Original files are never modified.** The tool reads from the folder. It writes only to `.llm-kb/`. If the user deletes `.llm-kb/`, their documents are untouched.

4. **Graceful on bad files.** Corrupted PDF? Log a warning, skip it, continue. Don't crash the whole ingest because one file is broken.

5. **Token-conscious.** Use Haiku for indexing (cheap, fast). Use Sonnet for Q&A (quality). Don't use Opus unless the user explicitly configures it. Every query should cost < $0.05 at default settings.

6. **Offline-capable parsing.** All parsing (PDF, Excel, Word, PPT, CSV, text) runs locally. No cloud calls for parsing. OCR is the only optional cloud dependency (Azure bridge), and built-in Tesseract is the default.

7. **Works on Windows, Mac, Linux.** No Unix-only assumptions. No shell scripts. All Node.js.

---

## What We're NOT Building (Yet)

- **Multi-user auth.** This is a personal/team tool. No login.
- **Cloud hosting.** `npx` runs locally. Docker is for self-hosting. No managed service.
- **Real-time collaboration.** One user at a time. Concurrency is not a goal for v0.1.
- **Vector search.** If the wiki outgrows context windows, we add it. Not before.
- **Custom embeddings.** No ML pipeline. The LLM reads markdown.
- **Plugins/extensions.** Pi SDK skills handle this later. Not in v0.1.

---

## Pre-Mortem: How This Fails

*Shreyas Doshi's pre-mortem exercise — imagine it failed, why?*

| Failure | Why It Happened | Prevention |
|---|---|---|
| "Nobody tried it" | `npx` command didn't work out of the box. API key error. | Test on fresh machine. Clear error messages. |
| "Tried it, too slow" | Indexing 20 PDFs took 5 minutes. User left. | Show progress bar. Parse in parallel. Index once after all files. |
| "Answers were bad" | Index summaries were garbage → wrong files selected → bad answers. | Test with real corpora. Eval loop from day one. |
| "Too expensive" | Sonnet for indexing burned $2 on first run with 50 docs. | Haiku for indexing. Show token cost estimate before running. |
| "Broke on my files" | Encrypted PDF. 500MB Excel. PPTX with embedded video. | Max file size. Graceful skip. Clear warnings. |
| "Felt like a toy" | CLI only, no UI, no saved state. | Ship the web UI in v0.1. It's the difference between a script and a product. |

---

## Build Order (Maps to Blog Series)

| Phase | What | Blog Part |
|---|---|---|
| **1** | CLI skeleton + ingest adapters + watcher + indexer | Part 2 |
| **2** | Query + Research sessions + terminal query command | Part 3 |
| **3** | Web UI (chat, upload, sources, activity) | Part 4 |
| **4** | Eval (trace logger, eval session, report) | Part 5 |
| **5** | Docker + deploy | Part 6 |
| **6** | Citations (bounding boxes → highlight) | Part 7 |

**Phase 1 is the MVP.** After Phase 1, `npx llm-kb run ./folder` scans files, parses them, builds an index, watches for new files, and shows a progress bar. No query yet — that's Phase 2. But the ingest pipeline is complete and the blog can show real output.

---

## Definition of Done for Phase 1

- [ ] `npx llm-kb run ./folder` scans and parses all supported file types
- [ ] Progress bar shows parsing status
- [ ] `.llm-kb/wiki/sources/` contains one `.md` per source file
- [ ] `.llm-kb/wiki/sources/` contains `.json` with bounding boxes for PDFs and images
- [ ] `.llm-kb/wiki/index.md` is generated with summary table
- [ ] File watcher auto-ingests new files dropped into the folder
- [ ] Unsupported/corrupt files are skipped with a warning
- [ ] Works on Windows, Mac, Linux
- [ ] `config.json` auto-generated on first run
- [ ] API key read from env or Pi auth storage
- [ ] README has one-command quickstart
- [ ] Blog Part 2 written with real terminal output screenshots

---

*Spec written April 4, 2026. DeltaXY.*
