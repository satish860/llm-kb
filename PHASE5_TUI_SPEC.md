# llm-kb — Phase 5 Slice 0: TUI Citations

> **Goal:** Validate citation → bounding box matching in the terminal before building any UI.
> **Effort:** 2-3 days
> **Prerequisite:** Bounding box JSON already saved per PDF (pdf.ts ✅)

---

## What Changes

### 1. Agent Returns Structured Citations

Update the AGENTS.md instructions to require a citation block at the end of each answer:

```markdown
## Citation Format

After your answer, list every source you used:

CITATIONS:
- file: "lease-agreement.md", page: 12, quote: "Lease Start Date: 15 March 2019"
- file: "certificate-of-acceptance.md", page: 3, quote: "Commencement Date: 15 March 2019"

Rules:
- The quote must be the EXACT text from the source file, not paraphrased
- Include the page number where you found it
- Every factual claim in your answer must have a citation
- If you can't find the exact quote, still cite but mark as approximate
```

### 2. Parse Citations from Agent Response

New function in `src/citations.ts`:

```typescript
interface RawCitation {
  file: string;
  page: number;
  quote: string;
}

function parseCitations(agentResponse: string): {
  answer: string;        // response text without citation block
  citations: RawCitation[];
}
```

Parse the `CITATIONS:` block from the end of the agent response. Regex-based, handles multi-line quotes.

### 3. Match Quotes Against Bounding Boxes

Core matching function:

```typescript
interface MatchedCitation {
  file: string;
  page: number;
  quote: string;
  matched: boolean;
  confidence: number;          // 0-1, based on fuzzy match quality
  boundingBoxes: BoundingBox[];  // [{x, y, width, height}]
  mergedRect: BoundingBox;     // single rectangle covering all matched items
}

async function matchCitation(
  citation: RawCitation,
  kbDir: string              // path to .llm-kb/
): Promise<MatchedCitation>
```

**Algorithm:**

```
1. Load .llm-kb/parsed/{filename without .md}.json
2. Get textItems for the cited page
3. Build text runs by concatenating adjacent textItems
   (items within 5px horizontal distance = same run)
4. Sliding window: try to match the quote against runs
   - Exact match first (fast path)
   - Normalized match (lowercase, collapse whitespace)
   - Fuzzy match (Levenshtein distance threshold)
5. If matched: return bounding boxes of all matched textItems
6. If not matched: return { matched: false, confidence: 0, boundingBoxes: [] }
7. Merge adjacent boxes into one highlight rectangle
```

**Text run building — why it matters:**

PDF textItems are often single words or fragments:
```json
[
  { "text": "Lease", "x": 142, "y": 340, "width": 45, "height": 14 },
  { "text": "Start", "x": 190, "y": 340, "width": 38, "height": 14 },
  { "text": "Date:", "x": 231, "y": 340, "width": 40, "height": 14 },
  { "text": "15",    "x": 280, "y": 340, "width": 16, "height": 14 },
  { "text": "March", "x": 299, "y": 340, "width": 42, "height": 14 },
  { "text": "2019",  "x": 344, "y": 340, "width": 32, "height": 14 }
]
```

We concatenate these into: `"Lease Start Date: 15 March 2019"` at position `(142, 340)` → `(376, 354)`.

Then fuzzy-match the agent's quote against this concatenated text.

### 4. TUI Display

After matching, display citations in the TUI:

```
── Answer ──────────────────────────────────────

Lease Start Date is 15 March 2019. The lease
was executed between EasyJet and SMBC Aviation.

── Citations ───────────────────────────────────

  [1] 📄 lease-agreement.md, p.12
      "Lease Start Date: 15 March 2019"
      ✅ verified (142,340 → 376,354)

  [2] 📄 lease-agreement.md, p.2
      "executed between EasyJet Airline Company
       Limited and SMBC Aviation Capital"
      ✅ verified (98,186 → 520,200)

── 4.2s · 2 files · 2/2 citations verified ────
```

Status indicators:
- `✅ verified` — exact or near-exact match found in bbox data
- `⚠️ approximate` — fuzzy match, confidence < 0.8
- `❌ not found` — no match in bbox data (agent may have paraphrased)

### 5. `/cite` Command — Open Highlighted Page

In the TUI chat, typing `/cite 1` does:

```
1. Get citation [1]'s bounding boxes
2. Render the PDF page as a PNG image (using pdf.ts page rendering)
3. Draw highlight rectangles on the image (using sharp composite)
4. Save to .llm-kb/highlights/{file}-p{page}.png
5. Open the image with system viewer (open/xdg-open/start)
```

```
> /cite 1

  Rendering lease-agreement.pdf page 12...
  Highlight: "Lease Start Date: 15 March 2019"
  Saved: .llm-kb/highlights/lease-agreement-p12.png
  Opening...
```

This proves the full pipeline works: agent answer → citation → quote → bbox match → highlighted page image.

### 6. Page Rendering (for /cite command)

New file: `src/page-renderer.ts`

```typescript
async function renderPage(
  pdfPath: string,
  pageNum: number,
  highlights: BoundingBox[],
  outputPath: string
): Promise<void>
```

Uses pdf.js to render page to canvas → PNG buffer → sharp to overlay semi-transparent rectangles → save.

Alternative: use the same LiteParse page rendering + sharp overlay that the blog post describes.

---

## Files

| File | What |
|---|---|
| `src/citations.ts` | Parse citations + match against bbox JSON |
| `src/page-renderer.ts` | Render PDF page as PNG with highlight overlays |
| Update `src/query.ts` | Inject citation format into AGENTS.md, parse response |
| Update `src/tui-display.ts` | Show citation blocks + `/cite` command |
| Update `AGENTS.md template` | Add citation format instructions |

---

## Implementation Order

| Step | What | Effort |
|---|---|---|
| 1 | Update AGENTS.md template with citation format | 0.5 day |
| 2 | `citations.ts` — parse citations from response | 0.5 day |
| 3 | `citations.ts` — bbox matching (text runs + fuzzy match) | 1 day |
| 4 | Update `tui-display.ts` — show verified citations | 0.5 day |
| 5 | `page-renderer.ts` + `/cite` command | 1 day |
| **Total** | | **~3 days** |

---

## Success Criteria

1. Agent returns structured citations with exact quotes
2. 80%+ of quotes match against bbox data (verified)
3. `/cite N` opens a PNG with the correct text highlighted
4. Works for both text PDFs and scanned PDFs (Azure OCR bboxes)
5. No changes to existing TUI chat flow — citations are additive

---

## What This Proves

If TUI citations work:
- The matching algorithm is solid → Web UI just renders the same data
- The agent can return structured citations reliably → No prompt engineering surprises
- The bounding box data from pdf.ts is actually usable → Not just stored, but functional

This is the cheapest way to validate before building the web UI.

---

*The bounding boxes have been sitting in `.llm-kb/parsed/*.json` since v0.1.0. Time to use them.*
