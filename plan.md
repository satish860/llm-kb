# llm-kb — Phase 1 Build Plan

> Emergent design. Each slice is a thin vertical slice that works end-to-end, is demoable, and informs the next step. Decisions are made at the last responsible moment.

## Key Learnings So Far
- **PDF is the only adapter we build.** Everything else (Excel, Word, PPT, CSV, images) can be handled dynamically by Pi SDK skills at query time.
- **`@llamaindex/liteparse`** is proven (from parser-study). Extracts text + bounding boxes locally. No cloud needed for native-text PDFs.
- **Two-output pattern**: `.md` (spatial text for LLM) + `.json` (bounding boxes for citations).
- **OCR strategy**: Tesseract.js locally by default. If `OCR_SERVER_URL` is in `.env`, route scanned pages there. OCR server is a separate project.
- **Pi SDK** (`createAgentSession`) is the agent runtime — proven in parser-study for extraction tasks.

---

## Slice 1: "Hello World" CLI ✅
**Do:** `llm-kb run ./folder` prints "Scanning ./folder..." and lists files found.
**Success Criteria:** Run against a test folder with mixed files. See file names and extensions printed.
**Checkpoint:** Does Commander feel right? Is the bin entry wired correctly?
**Status:** ✅ Done

---

## Slice 2: PDF → markdown + bounding boxes
**Do:** `llm-kb run ./folder` finds PDFs → parses with LiteParse → writes `.md` + `.json` to `.llm-kb/wiki/sources/`. Creates the folder structure.
**Success Criteria:** Run against the `2023 new laws` folder. Each PDF produces a readable `.md` and a `.json` with bounding boxes in `.llm-kb/wiki/sources/`.
**Checkpoint:** Is the markdown quality readable? Do bounding boxes look correct? How fast is it?
**Status:** ✅ Done

---

## Slice 3: Scanned PDF handling (OCR)
**Do:** Detect scanned pages (LiteParse's page classification). Use Tesseract.js locally. If `OCR_SERVER_URL` env var exists, route scanned pages there instead.
**Success Criteria:** A scanned PDF produces readable markdown. Native-text PDFs still work fast (no OCR overhead).
**Checkpoint:** Is Tesseract.js quality acceptable? Is the OCR server interface clean enough to swap providers later?
**Status:** ✅ Done — LiteParse has Tesseract.js built-in. Just `ocrEnabled: true` + pass `OCR_SERVER_URL` env var.

---

## Slice 4: Progress + error handling
**Do:** Add progress bar for parsing. Handle corrupt/encrypted PDFs gracefully (skip + warn). Handle unsupported file types (skip + warn).
**Success Criteria:** Run against 10+ files. See progress. Throw a bad PDF in. It doesn't crash.
**Checkpoint:** Does the terminal output match what the spec envisions?
**Status:** ✅ Done

---

## Slice 5: Indexer (Pi SDK + Haiku)
**Do:** Read all `sources/*.md` → Pi SDK `createAgentSession` with Haiku → write `index.md` with summary table. API key from `ANTHROPIC_API_KEY` env var.
**Success Criteria:** `index.md` exists with a meaningful summary of all parsed sources. Cost < $0.05.
**Checkpoint:** Is the index quality good enough for query routing later? Is Pi SDK the right tool here or would raw Anthropic SDK be simpler?
**Status:** ⬜ Not started

---

## Slice 6: File watcher
**Do:** After initial scan+parse, watch the folder with chokidar. New/changed PDFs get parsed automatically. Re-index after changes.
**Success Criteria:** Start `run`, drop a PDF in, see it appear in `sources/` and `index.md` updated — without restarting.
**Checkpoint:** Should we debounce/batch re-indexing? Does watching + parsing + indexing feel responsive?
**Status:** ⬜ Not started

---

## Slice 7: Config + polish
**Do:** Auto-generate `.llm-kb/config.json` on first run. Respect `ignorePatterns`. Clean terminal output matching the spec's vision. `--port`, `--no-open`, `--watch-only` flags.
**Success Criteria:** Full `llm-kb run ./folder` experience matches the spec's terminal output. Config is editable and respected on re-run.
**Checkpoint:** Is this ready to demo for the blog? What's missing for the Phase 1 definition of done?
**Status:** ⬜ Not started

---

## Notes
- No slice is built until the previous one proves the interface works.
- Other file types (Excel, Word, PPT, CSV, images) are NOT built as adapters. Pi SDK skills handle them at query time.
- OCR server is a separate project. llm-kb just calls it if `OCR_SERVER_URL` is set.
- Every checkpoint question might change the next slice.
- This plan will evolve as we learn.
