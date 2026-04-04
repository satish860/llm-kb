# llm-kb — Product Spec

> **One-liner:** Drop files into a folder. Get a knowledge base you can query.
> **npm:** `npx llm-kb run ./my-documents`
> **Status:** Phase 1 complete. Ingest pipeline + CLI.

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
llm-kb v0.0.1

Scanning ./research...
  Found 12 files (12 PDF)
  12 parsed

  Building index...
  Index built: .llm-kb/wiki/index.md

  Output: ./research/.llm-kb/wiki/sources

  Watching for new files... (Ctrl+C to stop)
```

Drop more files in while it's running. They get ingested automatically.

**That's the whole first-run experience.** No config file. No API key prompt (uses Pi SDK auth). No Docker. Just point at a folder.

---

## Commands

### `llm-kb run <folder>` (Phase 1 ✅)

The main command. Does everything:

1. Scans the folder for PDF files
2. Parses each PDF to markdown + JSON bounding boxes (via LiteParse)
3. Skips already-parsed files (mtime check — re-runs are instant)
4. Builds `index.md` from all parsed sources (via Pi SDK agent)
5. Starts a file watcher on the folder (new PDFs get auto-ingested + re-indexed)

**Data layout it creates inside the folder:**

```
./my-documents/
├── (your original files — untouched)
└── .llm-kb/
    └── wiki/
        ├── index.md
        └── sources/
            ├── report.md          ← spatial text layout
            ├── report.json        ← per-word bounding boxes
            └── ...
```

**Key decision:** `.llm-kb/` lives inside the user's folder, not in a global location. The knowledge base is co-located with the documents. Delete the folder, delete the KB. Copy the folder to another machine, the KB comes with it.

### `llm-kb query <question>` (Phase 2)

Query from the terminal without starting the web UI:

```bash
llm-kb query "what are the reserve requirements?" --folder ./research
llm-kb query "compare Q3 vs Q4 guidance" --folder ./research --save
```

### `llm-kb status` (Phase 2)

Show what's in the knowledge base.

### `llm-kb eval` (Phase 4)

Run the eval loop manually.

---

## File Type Strategy

**Key architectural decision: PDF is the only file type parsed at ingest time.** All other file types are handled dynamically by the Pi SDK agent at query time using pre-bundled libraries.

### Why?

- PDFs are binary, slow to parse, and need specialized libraries — worth pre-processing
- Everything else (Excel, Word, PPT, CSV) — the Pi SDK agent can write a quick script to read them on demand
- This eliminates 6 parser adapters, a router, and an adapter interface
- The agent is smarter than a static adapter — it can decide what's relevant

### PDF Parsing (Ingest Time)

| Extension | Parser | Output | Bounding Boxes |
|---|---|---|---|
| `.pdf` | @llamaindex/liteparse | `.md` + `.json` | ✅ Yes |

### Other File Types (Query Time — Agent Handles Dynamically)

These libraries are pre-bundled in llm-kb and available to the agent via `NODE_PATH`:

| Library | File Types |
|---|---|
| exceljs | `.xlsx`, `.xls` |
| mammoth | `.docx` |
| officeparser | `.pptx` |

The agent's `AGENTS.md` context (injected via Pi SDK `agentsFilesOverride`) tells it which libraries are available and how to use them.

---

## OCR Strategy

Page-level routing — only scanned pages get OCR, native text pages are free and instant.

```
PDF Page → LiteParse classifies → native text? → keep local (free)
                                → scanned?     → route to OCR
```

**OCR is off by default** (most PDFs have native text, avoids noisy Tesseract warnings).

**Enable via env vars:**
- `OCR_ENABLED=true` → local Tesseract.js (built into LiteParse)
- `OCR_SERVER_URL=http://...` → remote Azure Document Intelligence bridge (faster, better quality)

The OCR server is a separate project. llm-kb just calls it if the env var is set.

---

## Auth & Model

**No API key handling in llm-kb.** Uses Pi SDK's `createAgentSession()` with defaults:
- Auth from `~/.pi/agent/auth.json` (existing Pi installation)
- Model from Pi's settings (whatever the user has configured)
- No config file, no env var for model selection

```typescript
const { session } = await createAgentSession({
  cwd: folder,
  resourceLoader: loader,   // injects AGENTS.md
  tools: [readTool, bashTool, writeTool],
  sessionManager: SessionManager.inMemory(),
});
```

---

## Tech Stack (Phase 1 — What's Built)

```
TypeScript (strict)
├── CLI: Commander
├── Build: tsup (single bin/cli.js)
├── Dev: Bun
├── PDF parsing: @llamaindex/liteparse (local, bounding boxes)
├── OCR: Tesseract.js (via LiteParse) or remote OCR server
├── File watching: chokidar (debounced)
├── Indexing: @mariozechner/pi-coding-agent (createAgentSession)
├── Pre-bundled for agent: exceljs, mammoth, officeparser
└── No database. No vector store. Files only.
```

---

## Project Structure (Actual)

```
llm-kb/
├── bin/
│   └── cli.js                 ← Built by tsup (single file)
├── src/
│   ├── cli.ts                 ← Commander entry point
│   ├── scan.ts                ← Recursive folder scan + extension filter
│   ├── pdf.ts                 ← LiteParse → .md + .json
│   ├── indexer.ts             ← Pi SDK agent → writes index.md
│   └── watcher.ts             ← chokidar file watcher (debounced)
├── package.json
├── tsconfig.json
├── plan.md                    ← Emergent build plan
├── README.md
└── SPEC.md                    ← This file
```

---

## Constraints

1. **Zero config for first run.** `npx llm-kb run ./folder` must work with Pi SDK auth. No config file needed. No init step.

2. **No global state.** Everything lives in `.llm-kb/` inside the user's folder. Two different folders = two independent knowledge bases.

3. **Original files are never modified.** Reads from the folder, writes only to `.llm-kb/`.

4. **Graceful on bad files.** Corrupted PDF? Log a warning, skip it, continue. Show clean summary: `9 parsed, 1 failed`.

5. **Token-conscious.** Pi SDK uses whatever model the user has configured. Indexing reads first ~500 chars of each file.

6. **Offline-capable parsing.** PDF parsing runs locally via LiteParse. OCR is the only optional cloud dependency.

7. **Works on Windows, Mac, Linux.** Tested on Windows. All Node.js, no shell scripts.

8. **Skip up-to-date files.** Re-runs are instant — mtime check skips already-parsed PDFs.

---

## What We're NOT Building (Yet)

- **Multi-user auth.** Personal/team tool. No login.
- **Cloud hosting.** Runs locally. Docker later.
- **Real-time collaboration.** One user at a time.
- **Vector search.** If the wiki outgrows context windows, we add it. Not before.
- **Custom embeddings.** No ML pipeline. The LLM reads markdown.
- **Config file.** Nothing reads it yet. Add when Phase 2/3 needs it (model selection, port, etc).
- **Static file adapters.** No Excel/Word/PPT adapters. Pi SDK agent handles them dynamically.

---

## Pre-Mortem: How This Fails

| Failure | Why It Happened | Prevention |
|---|---|---|
| "Nobody tried it" | `npx` didn't work. Pi SDK not installed. | Clear prerequisites in README. |
| "Tried it, too slow" | Indexing 20 PDFs took 5 minutes. | ✅ Progress bar. Skip up-to-date. Parse once. |
| "Answers were bad" | Index summaries garbage → wrong files selected. | Test with real corpora. Eval loop (Phase 4). |
| "Too expensive" | LLM burned tokens on indexing. | Agent reads first ~500 chars per file, not full content. |
| "Broke on my files" | Encrypted PDF. 500MB file. | ✅ Graceful skip. Clean error messages. |
| "Felt like a toy" | CLI only, no UI, no saved state. | Web UI in Phase 3. |

---

## Build Order (Maps to Blog Series)

| Phase | What | Status |
|---|---|---|
| **1** | CLI + PDF parsing + indexer + watcher | ✅ Done |
| **2** | Query + Research sessions + terminal query command | Next |
| **3** | Web UI (chat, upload, sources, activity) | Planned |
| **4** | Eval (trace logger, eval session, report) | Planned |
| **5** | Docker + deploy | Planned |
| **6** | Citations (bounding boxes → highlight in PDF) | Planned |

---

## Phase 1 — Definition of Done

- [x] `llm-kb run ./folder` scans and parses PDFs
- [x] Inline progress shows parsing status
- [x] `.llm-kb/wiki/sources/` contains `.md` + `.json` per PDF
- [x] `.llm-kb/wiki/index.md` generated with summary table
- [x] File watcher auto-ingests new PDFs dropped into the folder
- [x] Corrupt files skipped with warning, don't crash
- [x] Re-runs skip up-to-date files (instant)
- [x] OCR support via env var (local Tesseract or remote server)
- [x] Auth via Pi SDK (no separate API key config)
- [x] Works on Windows (tested), Mac/Linux (Node.js, should work)
- [x] README has quickstart
- [ ] Blog Part 2 written with real terminal output screenshots

---

*Spec written April 4, 2026. Updated after Phase 1 build. DeltaXY.*
