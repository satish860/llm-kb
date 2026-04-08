# llm-kb — Phase 5: Citations With Bounding Boxes + Web UI

> **What we have (v0.4.0):** TUI chat, concept wiki, eval loop, bounding box JSON already saved per PDF.
>
> **What's missing:** The agent answers with citations like "(q3-report.md, p.4)" but you can't click on it, see the source page, or verify the highlighted text. The bounding box data exists — it's just not connected to the answers.

---

## The Problem

The agent says: *"Lease Start Date is 15 March 2019 (lease-agreement.md, p.12)"*

The user thinks: **Show me. Where exactly on page 12?**

Right now they can't verify. They'd have to open the original PDF, scroll to page 12, and search for the text. That's the same workflow they had before the AI.

For regulated industries (aviation, finance, legal) — unverifiable citations are useless. An auditor doesn't trust "page 12." They trust a highlighted rectangle on the actual page.

---

## What Phase 5 Delivers

### 1. Citation Extraction — Agent Returns Source Coordinates

The agent already cites sources: `(filename, page)`. Phase 5 makes it return the **exact quoted text** alongside the citation.

**Current agent output:**
```
Lease Start Date is 15 March 2019 (lease-agreement.md, p.12)
```

**Phase 5 agent output:**
```
Lease Start Date is 15 March 2019

[citation: lease-agreement.md, page 12, quote: "Lease Start Date: 15 March 2019"]
```

The `quote` field is the exact text string from the source that supports the claim. This is the bridge to bounding boxes — we fuzzy-match the quote against the stored textItems to find coordinates.

**Implementation:**
- Update AGENTS.md instructions to require `[citation: file, page, quote]` format
- Parse citations from agent response using regex
- Match quote text against `.json` bounding box data for that file + page
- Return citation objects: `{ file, page, quote, boundingBoxes: [{x, y, w, h}] }`

### 2. Bounding Box Matching — Quote → Coordinates

We already have per-word bounding boxes in `.llm-kb/parsed/{name}.json`. The matching algorithm:

```
Input:  quote = "Lease Start Date: 15 March 2019"
        file  = "lease-agreement.json", page = 12

Step 1: Get all textItems for page 12
Step 2: Concatenate adjacent textItems into runs
Step 3: Fuzzy-match the quote against runs
        (handle whitespace, OCR artifacts, line breaks)
Step 4: Return the bounding boxes of all matched textItems
Step 5: Merge adjacent boxes into highlight rectangles
```

**Edge cases:**
- Quote spans multiple lines → multiple bounding boxes, merge vertically
- OCR text slightly different from quote → fuzzy matching (Levenshtein distance < 3)
- Quote is paraphrased by agent → fall back to page-level citation (no highlight)
- Scanned PDF → bounding boxes from Azure OCR (already handled in pdf.ts)

**New file:** `src/citations.ts`

### 3. Web UI — Browse, Search, Verify

Replace TUI-only mode with an optional local web UI.

```bash
llm-kb run ./my-documents          # TUI mode (existing, unchanged)
llm-kb run ./my-documents --ui     # Opens browser at localhost:3000
```

**Layout:**

```
┌─────────────────────────────────────────────────────────────┐
│  llm-kb                                    [docs] [wiki]   │
├──────────────────────┬──────────────────────────────────────┤
│                      │                                      │
│  Chat                │  Source Viewer                       │
│                      │                                      │
│  > What is the       │  ┌────────────────────────────┐     │
│    lease start date? │  │                            │     │
│                      │  │   Page 12 of               │     │
│  Lease Start Date    │  │   lease-agreement.pdf      │     │
│  is 15 March 2019.   │  │                            │     │
│                      │  │   ┌──────────────────┐     │     │
│  📄 lease-agreement  │  │   │ Lease Start Date │     │     │
│     p.12 ← click     │  │   │ 15 March 2019   │     │     │
│                      │  │   └──────────────────┘     │     │
│                      │  │        ↑ highlighted       │     │
│  > next question...  │  │                            │     │
│                      │  └────────────────────────────┘     │
│                      │                                      │
├──────────────────────┴──────────────────────────────────────┤
│  Wiki: 29 concepts · 66% hit rate · 22 eval issues         │
└─────────────────────────────────────────────────────────────┘
```

**Panels:**

| Panel | What | How |
|---|---|---|
| **Chat** (left) | Ask questions, see answers with clickable citations | WebSocket to agent session |
| **Source Viewer** (right) | Rendered PDF page with highlighted bounding boxes | Page image + SVG overlay |
| **Status Bar** (bottom) | Wiki stats, eval metrics, cost tracking | Reads from .llm-kb/ files |

**Page rendering approach:**
- Don't embed a full PDF viewer (heavy, complex)
- Render each page as an image using `pdf.js` canvas or `sharp`
- Overlay SVG rectangles for bounding box highlights
- Clicking a citation in chat → Source Viewer jumps to that page with highlights

**Tech stack:**
- Server: Express or Hono (lightweight, ships with llm-kb)
- Client: Vanilla HTML + minimal JS (no React, no build step)
- WebSocket: For streaming agent responses to browser
- Page images: Generated on-demand from PDF, cached in `.llm-kb/pages/`

### 4. Wiki Browser

The web UI includes a wiki tab:

```
┌─────────────────────────────────────────────┐
│  Wiki                          29 concepts  │
├─────────────────────────────────────────────┤
│                                             │
│  ## Mob Lynching                            │
│  First-ever criminalisation in Indian law   │
│  under BNS 2023, Clause 101(2)...          │
│  Sources: IPC (p.137), Comparison (p.15)   │
│           ↑ clickable → Source Viewer       │
│                                             │
│  ## Electronic Evidence                     │
│  Section 65B of the Indian Evidence Act...  │
│  Sources: Evidence Act (p.42)              │
│                                             │
└─────────────────────────────────────────────┘
```

Wiki concepts are rendered as cards. Source citations in the wiki are clickable — opens Source Viewer with highlights.

---

## Architecture

```
llm-kb run ./docs --ui

  ┌──────────────────────────────────────┐
  │  Express server (localhost:3000)     │
  │                                      │
  │  GET /              → Chat + Viewer  │
  │  GET /wiki          → Wiki browser   │
  │  GET /page/:file/:n → Page image     │
  │  WS  /chat          → Agent session  │
  │  GET /citations     → Bbox overlays  │
  └──────────┬───────────────────────────┘
             │
             ▼
  ┌──────────────────────────────────────┐
  │  Pi SDK createAgentSession()        │
  │  Same as TUI — different output     │
  │                                      │
  │  Agent response → parse citations   │
  │  → match against bbox JSON          │
  │  → stream to browser via WebSocket  │
  └──────────────────────────────────────┘
```

**Key principle:** The web UI is a thin layer over the same agent sessions. No new AI logic. The agent doesn't know it's in a browser — it still reads files, writes wiki, follows guidelines. The UI just renders the output differently and adds citation linking.

---

## Implementation Order

| Slice | What | Effort | Delivers |
|---|---|---|---|
| **5.1** | Citation format in AGENTS.md + parse citations from response | 1 day | Structured citations with quotes |
| **5.2** | `citations.ts` — fuzzy-match quotes against bbox JSON | 2 days | `{ file, page, quote, boxes[] }` objects |
| **5.3** | Page image renderer (PDF → PNG per page, cached) | 1 day | `/page/:file/:pageNum` endpoint |
| **5.4** | Web server + static chat UI + WebSocket streaming | 2 days | `--ui` flag, basic chat in browser |
| **5.5** | Source Viewer panel + SVG highlight overlays | 2 days | Click citation → see highlighted page |
| **5.6** | Wiki browser tab | 1 day | Browse concepts, click sources |
| **5.7** | TUI citation display (non-UI mode gets quotes too) | 0.5 day | Even CLI users get better citations |
| **Total** | | **~9-10 days** | |

---

## What This Enables

1. **Verifiable AI answers** — Every claim links to a highlighted rectangle on the source page. Auditors can verify in 2 seconds.

2. **Blog post: "Citations That Point to the Exact Line"** — This is the post that connects llm-kb (developer tool) to DeltaXY (enterprise document AI). Same bounding box tech used in Hera for GT.

3. **Demo material** — A web UI with highlighted citations is 100x more compelling in a demo than TUI output. LinkedIn video of "ask a question, see the source highlighted" will outperform the text posts.

4. **Bridge to commercial** — The citation + UI layer is what separates a CLI tool from an enterprise product. This is the path from llm-kb (free) to audit/compliance tools (paid).

---

## What NOT to Build

- ❌ Full PDF viewer (use page images + SVG overlay instead)
- ❌ React/Next.js frontend (vanilla HTML, no build step)
- ❌ User auth / multi-user (local tool, single user)
- ❌ Cloud deployment (localhost only)
- ❌ Edit wiki from UI (edit .md files directly)

---

*Phase 5 connects the bounding box data we already have to the answers we already generate. The hardest part (parsing + bbox extraction) is done. This phase is wiring.*
