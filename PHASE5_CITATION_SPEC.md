# llm-kb — Phase 5: Citations + Source Verification UI

> **Current state (v0.4.0):** TUI chat, concept wiki, eval loop, bounding box JSON saved per PDF.
>
> **What's missing:** Agent answers cite `(filename, p.X)` but you can't verify. The bbox data exists in `.llm-kb/wiki/sources/*.json` — it's just not connected to answers.
>
> **This phase:** Make citations structured, verifiable, and clickable.

---

## The Problem

The agent says: *"Lease Start Date is 15 March 2019 (lease-agreement.md, p.12)"*

The user thinks: **Show me. Where exactly on page 12?**

Today they'd have to open the original PDF, scroll to page 12, and manually search. That's the same workflow they had before the AI.

For regulated industries (aviation, finance, legal) — unverifiable citations are useless. An auditor needs a highlighted rectangle on the source page, not "page 12."

---

## What Phase 5 Delivers

Two slices. TUI-first (validate the matching works), then web UI (make it visual).

---

## Slice 1: Structured Citations in TUI (3 days)

### 1.1 — Agent Returns Structured Citations

Update the AGENTS.md template in `query.ts → buildQueryAgents()` to require a structured citation block at the end of every answer:

**Add to the `## Rules` section:**

```markdown
## Citation Format

After your answer, include a CITATIONS block listing every source used:

CITATIONS:
- file: "lease-agreement.md", page: 12, quote: "Lease Start Date: 15 March 2019"
- file: "certificate.md", page: 3, quote: "Commencement Date: 15 March 2019"

Rules for citations:
- The quote MUST be the EXACT text from the source, not paraphrased
- Include the page number where you read it
- Every factual claim in your answer must have at least one citation
- If answering from wiki, cite the original sources listed in the wiki entry
```

**What changes in `query.ts`:**
- Add citation format instructions to `buildQueryAgents()` return string
- The agent's existing inline `(filename, page)` citations are fine — this ADDS a structured block at the end for machine parsing

### 1.2 — Parse Citations from Agent Response

**New file: `src/citations.ts`**

```typescript
interface RawCitation {
  file: string;
  page: number;
  quote: string;
}

interface ParseResult {
  answer: string;          // response text WITHOUT the CITATIONS block
  citations: RawCitation[];
}

function parseCitations(agentResponse: string): ParseResult
```

**Logic:**
1. Find `CITATIONS:` line in the response (case-insensitive)
2. Everything before it = `answer`
3. Parse each `- file: "...", page: N, quote: "..."` line with regex
4. Handle multi-line quotes (quote continues until next `- file:` or end)
5. If no CITATIONS block found, return `{ answer: full response, citations: [] }`

### 1.3 — Match Quotes Against Bounding Boxes

**Core function in `src/citations.ts`:**

```typescript
interface MatchedCitation extends RawCitation {
  matched: boolean;
  confidence: number;           // 0-1
  boundingBoxes: BoundingBox[]; // individual word/fragment boxes
  mergedRect: BoundingBox;      // single enclosing rectangle
}

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function matchCitation(
  citation: RawCitation,
  sourcesDir: string          // .llm-kb/wiki/sources/
): Promise<MatchedCitation>
```

**Algorithm:**

```
1. Load {sourcesDir}/{filename-without-.md}.json
   (e.g. "lease-agreement.md" → "lease-agreement.json")
2. Get the page object for citation.page
3. Get all textItems for that page
4. Build text runs:
   - Sort textItems by y (top→bottom), then x (left→right)
   - Group items on the same line (y within 3px tolerance)
   - Concatenate items within a line (items within 5px horizontal gap)
   - Build a full page text string with line positions tracked
5. Match the quote:
   a. Exact substring match against page text (fast path)
   b. Normalized match (lowercase, collapse whitespace, strip punctuation)
   c. Fuzzy match (sliding window, Levenshtein distance < 15% of quote length)
6. If matched:
   - Find all textItems whose text contributes to the matched region
   - Return their bounding boxes
   - Merge adjacent boxes into a single highlight rectangle
7. If not matched:
   - Return { matched: false, confidence: 0, boundingBoxes: [] }
```

**Text run building — critical detail:**

PDF textItems are often individual words or fragments:
```json
[
  { "text": "Lease", "x": 142, "y": 340, "width": 45, "height": 14 },
  { "text": "Start", "x": 190, "y": 340, "width": 38, "height": 14 },
  { "text": "Date:", "x": 231, "y": 340, "width": 40, "height": 14 }
]
```

Must concatenate into `"Lease Start Date:"` at bbox `(142, 340) → (271, 354)` before matching.

**Edge cases:**
- Quote spans multiple lines → multiple bounding box groups, merge vertically
- OCR artifacts → fuzzy match handles minor differences (Levenshtein)
- Agent paraphrased the quote → `matched: false`, fall back to page-level citation
- JSON file doesn't exist (non-PDF source) → `matched: false`
- Page number out of range → `matched: false`

### 1.4 — Display Citations in TUI

**Update `query.ts` (subscribeDisplay function):**

After the agent finishes (`agent_end` event):
1. Call `parseCitations(answerText)` on the accumulated answer
2. Call `matchCitation()` for each citation
3. Display in TUI via `ChatDisplay` or stdout

**TUI display (new method on `ChatDisplay`):**

```
── Citations ────────────────────────────────────

  [1] 📄 lease-agreement.md, p.12
      "Lease Start Date: 15 March 2019"
      ✅ matched (142,340 → 376,354)

  [2] 📄 lease-agreement.md, p.2
      "executed between EasyJet and SMBC Aviation"
      ✅ matched (98,186 → 520,200)

  [3] 📄 notes.md, p.5
      "Amendment dated 15 June 2020"
      ⚠️ approximate (confidence: 0.72)

  [4] 📄 summary.md, p.1
      "Total fleet: 142 aircraft"
      ❌ not found in bbox data

── 4.2s · 2 files · 4 citations (3 verified) ──
```

**Add to `ChatDisplay`:**
- New method: `showCitations(citations: MatchedCitation[]): void`
- Shows after answer, before completion stats
- Status indicators: ✅ matched (confidence ≥ 0.8), ⚠️ approximate (0.5-0.8), ❌ not found (<0.5)

**Update completion stats line:**
- Change from `── 4.2s · 2 files read ──`
- To: `── 4.2s · 2 files · 4 citations (3 verified) ──`

### 1.5 — Update Trace Builder

**Update `KBTrace` interface in `trace-builder.ts`:**

```typescript
interface TraceCitation {
  file: string;
  page: number;
  quote: string;
  matched: boolean;
  confidence: number;
}

interface KBTrace {
  // ... existing fields ...
  citations?: TraceCitation[];
}
```

Store matched citations in traces so eval can check citation quality over time.

**Update eval.ts:**
- Metrics: track `citationsTotal`, `citationsVerified`, `citationsUnmatched`
- Report: add citation accuracy section
- The existing `judgeQA()` LLM judge already checks citation validity — now it can also check against bbox match results

### 1.6 — `/cite N` Command (Open Highlighted Page)

In TUI mode, typing `/cite 1` in the input:

```
1. Get citation [1] from last answer's matched citations
2. Render the PDF page as a PNG:
   a. Use pdf.js to render page → canvas → PNG buffer
   b. Use sharp to overlay semi-transparent yellow rectangles on matched bboxes
3. Save to .llm-kb/highlights/{file}-p{page}.png
4. Open with system viewer:
   - Windows: start "" "path.png"
   - macOS: open "path.png"
   - Linux: xdg-open "path.png"
```

**New file: `src/page-renderer.ts`**

```typescript
async function renderHighlightedPage(
  pdfPath: string,       // original PDF
  pageNum: number,
  highlights: BoundingBox[],
  outputPath: string
): Promise<void>
```

**Dependencies to add:**
- `pdfjs-dist` — render PDF page to canvas/image
- `sharp` — composite highlight overlay onto rendered page
- `canvas` — required by pdfjs-dist for Node.js rendering (or use pdfjs-dist's built-in SVG/image mode)

**Alternative (simpler, no new deps):**
- Skip page rendering entirely
- `/cite 1` opens the original PDF at the right page using system viewer
- Print the quote and bbox coordinates to terminal so user knows where to look
- This is cheaper but less magical

**Recommendation:** Start with the simple version (open PDF + print coordinates). Add image rendering as 5.1b if the simple version feels insufficient.

**Update `ChatDisplay`:**
- Intercept `/cite N` in `onSubmit` before sending to agent
- Parse N, look up citation, execute render/open

---

## Slice 2: Web UI with Source Viewer (7 days)

### 2.1 — Web Server Scaffold

**New file: `src/web/server.ts`**

```typescript
// Lightweight HTTP server (Hono or plain Node http)
// Launched by: llm-kb run ./docs --ui
// Opens browser at http://localhost:3947

GET /                    → SPA (single HTML file with inline JS/CSS)
GET /api/status          → KB stats (sources, wiki, config)
GET /api/wiki            → wiki.md content
GET /api/sources         → list of source files
GET /api/page/:file/:n   → rendered page image (PNG, cached)
GET /api/highlights      → bbox overlay data for current citations
WS  /ws/chat             → streaming agent session
```

**CLI change in `cli.ts`:**
- Add `--ui` flag to `run` command
- When `--ui`: start web server instead of TUI, open browser
- Agent session is the SAME — web UI is just a different rendering target

**Key principle:** Web UI is a thin layer. No new AI logic. The agent doesn't know it's in a browser. Same AGENTS.md, same tools, same wiki updates.

### 2.2 — Chat Panel (Left Side)

**File: `src/web/public/index.html` (single file, inline JS/CSS)**

WebSocket connection to `/ws/chat`. Renders:
- User messages (right-aligned or left with different style)
- Model indicator: `⟡ claude-sonnet-4-6`
- Thinking blocks (collapsible, dim)
- Tool calls (file reads, bash runs)
- Answer text (markdown rendered via marked.js or similar lightweight lib)
- Citation chips at end of answer — clickable

**Streaming protocol over WebSocket:**
```json
{ "type": "thinking_start" }
{ "type": "thinking_delta", "text": "..." }
{ "type": "thinking_end" }
{ "type": "tool_call", "id": "...", "label": "Reading file.md" }
{ "type": "tool_result", "id": "...", "isError": false }
{ "type": "text_start" }
{ "type": "text_delta", "text": "..." }
{ "type": "text_end" }
{ "type": "citations", "data": [{ "file": "...", "page": 1, "quote": "...", "matched": true, "confidence": 0.95, "boxes": [...] }] }
{ "type": "done", "elapsed": 4.2, "filesRead": 2 }
```

**Server side:** Reuse the same `session.subscribe()` pattern from `query.ts`, but route events to WebSocket instead of TUI/stdout. Extract into a shared `display-router.ts` that both TUI and WebSocket can consume.

### 2.3 — Source Viewer Panel (Right Side)

The right panel shows PDF pages with highlighted bounding boxes.

**Page rendering:**
1. Server renders PDF page → PNG using pdfjs-dist + canvas (Node.js)
2. Cache at `.llm-kb/pages/{file}-p{N}.png`
3. Client requests `GET /api/page/lease-agreement/12`
4. Client overlays SVG rectangles on top of the page image using bbox coordinates

**Why SVG overlay (not baked into image):**
- Different citations can highlight different regions on the same page
- Highlights can animate (pulse, fade in)
- Hover over citation in chat → corresponding highlight pulses in viewer
- No need to re-render the page image for different queries

**Page rendering detail (server-side):**

```typescript
// src/web/page-renderer.ts
import * as pdfjsLib from "pdfjs-dist";
import { createCanvas } from "canvas";
import sharp from "sharp";

async function renderPage(
  pdfPath: string,
  pageNum: number,
  scale: number = 2    // 2x for retina
): Promise<Buffer>       // PNG buffer
```

- Parse PDF with pdfjs-dist
- Get page, render to canvas at 2x scale
- Convert canvas to PNG buffer via sharp
- Cache to `.llm-kb/pages/`

**Client-side highlighting:**

```html
<div class="source-viewer" style="position: relative;">
  <img src="/api/page/lease-agreement/12" />
  <svg class="highlights" style="position: absolute; top: 0; left: 0;">
    <!-- Scaled to match image dimensions -->
    <rect x="142" y="340" width="234" height="14"
          fill="rgba(255, 220, 0, 0.3)"
          stroke="rgba(255, 180, 0, 0.6)" />
  </svg>
</div>
```

**Interaction:**
- Click citation chip in chat → Source Viewer loads that page + shows highlights
- Hover citation → highlight pulses
- Scroll through pages (prev/next buttons)
- Zoom controls (fit width, fit page, 100%, 200%)

### 2.4 — Wiki Browser Tab

Second tab in the UI. Renders `wiki.md` as formatted HTML.

```
GET /api/wiki → returns wiki.md content
```

Client renders markdown → HTML. Source citations in wiki entries are clickable — opens Source Viewer with highlights.

**Simple implementation:** Just render the wiki.md markdown. No fancy card layout. Wiki entries already have `*Sources: file1, file2 · date*` lines — make the file names clickable.

### 2.5 — Layout

```
┌─────────────────────────────────────────────────────────────┐
│  llm-kb                              [Chat] [Wiki] [Status] │
├──────────────────────┬──────────────────────────────────────┤
│                      │                                      │
│  Chat Panel          │  Source Viewer                       │
│  (2.2)               │  (2.3)                               │
│                      │                                      │
│  Messages stream     │  PDF page image                      │
│  here. Citations     │  with SVG highlight                  │
│  are clickable       │  overlays.                           │
│  chips at the end    │                                      │
│  of each answer.     │  Page nav: ◄ 12/45 ►                │
│                      │  Zoom: [Fit] [100%] [200%]          │
│                      │                                      │
│  ┌───────────────┐   │                                      │
│  │ Ask anything.. │   │                                      │
│  └───────────────┘   │                                      │
├──────────────────────┴──────────────────────────────────────┤
│  12 sources · 29 wiki concepts · 66% hit rate               │
└─────────────────────────────────────────────────────────────┘
```

**Responsive:** On narrow screens, Source Viewer goes below Chat (stacked).

### 2.6 — Server↔Agent Bridge

**New file: `src/web/agent-bridge.ts`**

Wraps `createChat()` from `query.ts` and bridges events to WebSocket:

```typescript
function bridgeToWebSocket(session: AgentSession, ws: WebSocket): void {
  // Subscribe to session events
  // Transform each event to the WebSocket JSON protocol (2.2)
  // Parse citations from answer on agent_end
  // Match against bboxes
  // Send citation data over WebSocket
}
```

This replaces the TUI display subscriber (`subscribeDisplay` in query.ts) for the web case. **Refactor opportunity:** Extract the core event processing from `subscribeDisplay` into a shared function that both TUI and WebSocket bridges can use.

---

## Tech Stack (New Dependencies)

| Package | Purpose | Size |
|---------|---------|------|
| `pdfjs-dist` | Render PDF pages to canvas (Node.js) | ~5MB |
| `canvas` | Node.js canvas for pdfjs-dist rendering | ~15MB native |
| `sharp` | Image compositing for highlight overlays (already common) | ~10MB native |
| `ws` | WebSocket server (lightweight) | ~100KB |
| `hono` | HTTP server (lightweight alternative to Express) | ~200KB |

**Alternative for page rendering (no native deps):**
- Use `mupdf.js` (WebAssembly, no native compilation)
- Or: serve the original PDF to the browser and use pdf.js client-side for rendering
- Client-side pdf.js rendering avoids ALL server-side deps (canvas, sharp, pdfjs-dist server)

**Recommendation:** Use **client-side pdf.js** for page rendering. The browser already has a canvas. Ship the original PDF to the browser, render pages with pdf.js in the browser, overlay SVG highlights. This eliminates canvas/sharp/pdfjs-dist as server dependencies. The server only needs to serve the PDF file and the bbox JSON.

With client-side rendering:

```
GET /api/pdf/:filename     → serves original PDF from user's folder
GET /api/bbox/:filename    → serves bbox JSON from .llm-kb/wiki/sources/
```

The client does all rendering. Zero native deps. Way simpler.

---

## File Changes Summary

### New Files
| File | What |
|---|---|
| `src/citations.ts` | Parse citations + fuzzy-match against bbox JSON |
| `src/page-renderer.ts` | PDF page → PNG with highlights (for `/cite` TUI command; skip if using client-side rendering) |
| `src/web/server.ts` | HTTP + WebSocket server |
| `src/web/agent-bridge.ts` | Agent session → WebSocket event bridge |
| `src/web/public/index.html` | SPA (single file, inline JS/CSS, client-side pdf.js) |

### Modified Files
| File | What Changes |
|---|---|
| `src/query.ts` | Add citation format to AGENTS.md template; parse + match citations on agent_end; extract shared event processing |
| `src/tui-display.ts` | Add `showCitations()` method; handle `/cite N` command in input |
| `src/trace-builder.ts` | Add `citations` field to `KBTrace` |
| `src/eval.ts` | Track citation accuracy metrics |
| `src/cli.ts` | Add `--ui` flag to `run` command |

---

## Build Order

| Step | What | Effort | Delivers |
|---|---|---|---|
| **5.1** | Citation format in AGENTS.md + `parseCitations()` | 0.5 day | Structured citations extracted from response |
| **5.2** | `matchCitation()` — text run building + fuzzy match against bbox JSON | 1.5 days | `{ matched, confidence, boundingBoxes }` per citation |
| **5.3** | TUI display of verified citations + updated completion stats | 0.5 day | User sees ✅/⚠️/❌ per citation in terminal |
| **5.4** | `/cite N` command (simple: open PDF + print coordinates) | 0.5 day | Quick source verification from TUI |
| **5.5** | Trace + eval updates (citation metrics) | 0.5 day | Track citation quality over time |
| — | **TUI citations done. Test + validate.** | — | — |
| **5.6** | Web server scaffold + SPA shell + WebSocket | 1.5 days | `--ui` flag opens browser, basic chat works |
| **5.7** | Agent bridge (session events → WebSocket JSON) | 1 day | Streaming chat in browser matches TUI |
| **5.8** | Source Viewer (client-side pdf.js + SVG highlights) | 2 days | Click citation → see highlighted page |
| **5.9** | Wiki browser tab | 0.5 day | Browse concepts in browser |
| **5.10** | Polish: responsive layout, keyboard shortcuts, hover states | 1 day | Production feel |
| **Total** | | **~10 days** | |

---

## Definition of Done

### Slice 1 (TUI Citations)
- [ ] Agent returns structured `CITATIONS:` block at end of answers
- [ ] `parseCitations()` extracts file, page, quote from response
- [ ] `matchCitation()` fuzzy-matches quotes against bbox JSON with >80% success rate
- [ ] TUI shows citation list with ✅/⚠️/❌ status after every answer
- [ ] Completion stats show citation count
- [ ] `/cite N` opens the source for verification
- [ ] Traces include citation data
- [ ] Eval reports citation accuracy metrics
- [ ] Works for both text PDFs and OCR PDFs

### Slice 2 (Web UI)
- [ ] `llm-kb run ./docs --ui` opens browser at localhost:3947
- [ ] Chat panel streams thinking, tool calls, answer text, citations
- [ ] Clicking a citation chip loads the PDF page in Source Viewer
- [ ] SVG highlights overlay on the correct bounding boxes
- [ ] Wiki tab renders wiki.md with clickable source references
- [ ] Status bar shows source count, wiki concepts, hit rate
- [ ] Single HTML file, no build step, no React
- [ ] Same agent session as TUI — no new AI logic

---

## What This Enables

1. **Verifiable AI answers.** Every claim → highlighted rectangle on source page. Auditors verify in 2 seconds.

2. **Blog post: "Citations That Point to the Exact Line."** Connects llm-kb (developer tool) to DeltaXY (enterprise document AI). Same bbox tech used in Hera for GT.

3. **Demo material.** Web UI with highlighted citations is 100x more compelling than terminal output. LinkedIn video of "ask → see source highlighted" will outperform text posts.

4. **Bridge to commercial.** Citation + UI is what separates a CLI tool from an enterprise product. Path from llm-kb (free) → audit/compliance tools (paid).

5. **Khaitan & Co demo.** If Aditya comes back with something concrete, this is what you show: drop their contracts in a folder, ask questions, see every answer traced back to the exact line in the source PDF.

---

## What NOT to Build

- ❌ Full PDF viewer (client-side pdf.js renders single pages, not a full viewer)
- ❌ React/Next.js/any framework (single HTML file, vanilla JS)
- ❌ User auth (localhost only, single user)
- ❌ Cloud deployment (local tool)
- ❌ Edit wiki from UI (edit files directly)
- ❌ Server-side page rendering if client-side works (avoid canvas/sharp deps)
- ❌ Annotation/editing of highlights (read-only verification)

---

*Phase 5 spec written April 7, 2026. DeltaXY.*
*The bounding boxes have been sitting in `.llm-kb/wiki/sources/*.json` since v0.1.0. Time to use them.*
