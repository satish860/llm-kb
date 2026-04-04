# llm-kb — Phase 1 Build Plan

> Emergent design. Each slice is a thin vertical slice that works end-to-end, is demoable, and informs the next step. Decisions are made at the last responsible moment.

## Key Learnings
- **PDF is the only adapter we build.** Everything else (Excel, Word, PPT, CSV, images) handled dynamically by Pi SDK agent at query time.
- **`@llamaindex/liteparse`** proven (from parser-study). Extracts text + bounding boxes locally.
- **Two-output pattern**: `.md` (spatial text) + `.json` (bounding boxes for citations).
- **OCR off by default.** Most PDFs have native text. Enable via `OCR_SERVER_URL` or `OCR_ENABLED=true`.
- **Pi SDK `createAgentSession()`** with defaults — no auth/model config needed. Uses Pi's existing auth.
- **AGENTS.md injected via `agentsFilesOverride`** — user's folder stays clean.
- **NODE_PATH** set so agent's bash scripts can use bundled libraries (exceljs, mammoth, officeparser).
- **Config file skipped** — nothing reads it yet. Add when Phase 2/3 needs it.

---

## Slice 1: "Hello World" CLI ✅
Commander CLI with `run <folder>`. Scans folder, lists files by extension.

## Slice 2: PDF → markdown + bounding boxes ✅
LiteParse parses PDFs → `.md` + `.json` in `.llm-kb/wiki/sources/`. Tested on 9 real PDFs (1000+ pages).

## Slice 3: Scanned PDF handling (OCR) ✅
LiteParse has Tesseract.js built-in. `ocrEnabled` + `ocrServerUrl` config. OCR off by default. Azure OCR bridge tested on 16 legal PDFs (3000+ pages).

## Slice 4: Progress + error handling ✅
Inline progress. Stderr suppression. Corrupt file skip + warning. Mtime check — re-runs instant.

## Slice 5: Indexer (Pi SDK) ✅
`createAgentSession` with cwd = user's folder. AGENTS.md injected. Agent reads sources, writes `index.md` with summary table.

## Slice 6: File watcher ✅
chokidar watches folder. New/changed PDFs → parse → re-index. 2s debounce for batch drops.

## Slice 7: Config + polish → Skipped
Config file has no readers yet. Deferred to Phase 2/3. README updated instead.

---

## Phase 1 Complete ✅

**What ships:**
- `llm-kb run ./folder` — scan, parse PDFs, build index, watch for new files
- Pre-bundled libraries for agent to handle Excel, Word, PowerPoint at query time
- OCR via env var (local Tesseract or remote Azure bridge)
- Auth via Pi SDK (zero config)

**What's next (Phase 2):**
- `llm-kb query "question" --folder ./research` — terminal query
- Pi SDK agent session for Q&A with read-only tools
- Research mode — agent writes answers to `outputs/`
