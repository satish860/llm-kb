# llm-kb

Drop files into a folder. Get a knowledge base you can query.

Inspired by [Karpathy's LLM Knowledge Bases](https://x.com/karpathy/status/2039805659525644595).

## Quick Start

```bash
npm install -g llm-kb
llm-kb run ./my-documents
```

That's it. Your PDFs get parsed to markdown, an index is built, and a file watcher keeps it up to date.

### Prerequisites

- **Node.js 18+**
- **Pi SDK** installed and authenticated (`npm install -g @mariozechner/pi-coding-agent` + run `pi` once to set up auth)

Pi handles the LLM auth — no separate API key configuration needed.

## What It Does

```
llm-kb run ./my-documents
```

```
llm-kb v0.0.1

Scanning ./my-documents...
  Found 9 files (9 PDF)
  9 parsed

  Building index...
  Index built: .llm-kb/wiki/index.md

  Output: ./my-documents/.llm-kb/wiki/sources

  Watching for new files... (Ctrl+C to stop)
```

1. **Scans** the folder for PDFs
2. **Parses** each PDF to markdown + bounding boxes (using [LiteParse](https://github.com/run-llama/liteparse))
3. **Builds an index** — Pi SDK agent reads all sources and writes `index.md` with summaries
4. **Watches** — drop a new PDF in while it's running, it gets parsed and indexed automatically

### What It Creates

```
./my-documents/
├── (your files — untouched)
└── .llm-kb/
    └── wiki/
        ├── index.md              ← summary of all sources
        └── sources/
            ├── report.md         ← parsed text (spatial layout)
            ├── report.json       ← bounding boxes (for citations)
            └── ...
```

Your original files are never modified. Delete `.llm-kb/` to start fresh.

## OCR for Scanned PDFs

Most PDFs have native text — they just work. For scanned PDFs:

**Local (default when enabled):**
```bash
OCR_ENABLED=true llm-kb run ./my-documents
```
Uses Tesseract.js (built-in, slower but works everywhere).

**Remote OCR server (faster, better quality):**
```bash
OCR_SERVER_URL="http://localhost:8080/ocr?key=YOUR_KEY" llm-kb run ./my-documents
```
Routes scanned pages to an Azure Document Intelligence bridge. Native-text pages still processed locally (free).

## Non-PDF Files

PDFs are parsed at ingest time. Other file types (Excel, Word, PowerPoint, CSV, images) are handled dynamically by the Pi SDK agent at query time — it writes quick scripts using pre-bundled libraries:

| Library | File Types |
|---|---|
| exceljs | `.xlsx`, `.xls` |
| mammoth | `.docx` |
| officeparser | `.pptx` |

No separate install needed — all bundled with llm-kb.

## How It Works

- **PDF parsing** — `@llamaindex/liteparse` extracts text with spatial layout + per-word bounding boxes. Runs locally, no cloud calls.
- **Indexing** — Pi SDK `createAgentSession` reads each source and generates a summary table in `index.md`.
- **File watching** — `chokidar` watches the folder. New/changed PDFs trigger re-parse + re-index (debounced for batch drops).
- **Auth** — uses Pi SDK's auth storage (`~/.pi/agent/auth.json`). No API keys in your project.

## Development

```bash
git clone https://github.com/satish860/llm-kb
cd llm-kb
bun install
bun run build
npm link

llm-kb run ./test-folder
```

## Tutorial

Building this in public: [themindfulai.dev](https://themindfulai.dev/articles/building-karpathy-knowledge-base-part-1)

## License

MIT
