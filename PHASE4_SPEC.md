# llm-kb — Phase 4: Farzapedia Pattern + Eval Loop

> **The data flywheel is already spinning (v0.3.0):**
> Query → Answer → Wiki updated → Next query answered from wiki → Faster, cheaper, compounding.
>
> Phase 4 makes the flywheel bigger: proactive compilation + eval-driven refinement.

---

## The Flywheel (what we already have)

```
         ┌─────────────┐
         │  User asks   │
         │  a question  │
         └──────┬───────┘
                │
                ▼
    ┌───────────────────────┐
    │  Agent answers from   │
    │  wiki (fast) or       │
    │  source files (slow)  │
    └───────────┬───────────┘
                │
                ▼
    ┌───────────────────────┐
    │  wiki.md updated      │◄─── Haiku merges new knowledge
    │  (topic-organized)    │     into existing wiki
    └───────────┬───────────┘
                │
                ▼
    ┌───────────────────────┐
    │  Next similar query   │
    │  answered from wiki   │──── 0 file reads, 2s instead of 25s
    └───────────────────────┘
```

**Proven in production:**
- First query about BNS 2023: 33s, 4 files read
- Same question again: 2s, 0 files read, answered from wiki
- Follow-up "tell me about mob lynching clause": instant, from wiki context

---

## What Phase 4 adds

### The problem with reactive-only wiki

The wiki only knows what users have asked. If nobody asks about electronic evidence,
that knowledge never makes it into the wiki. The first person to ask pays the full cost.

### The Farzapedia insight

> Compile the wiki **proactively** from all sources — BEFORE anyone asks.
> Then every query is fast from day one.

```
Current (reactive only):
  Sources exist → User asks → Agent reads sources → Answers → Wiki updated
  Problem: first query for every topic is slow

With compile (proactive + reactive):
  Sources exist → Compile articles → User asks → Instant answer from articles
  Plus: eval finds gaps → Articles refined → Even better answers
```

---

## Slices

### Slice 1: Article compiler (`llm-kb compile`)

**What:** Read all source files, identify key concepts, write one article per concept.

**Input:**
```
.llm-kb/wiki/sources/
  indian-penal-code-new.md (60 pages)
  annotated-comparison-bns-ipc.md (21 pages)
  evidence-act-new.md (40 pages)
  ...
```

**Output:**
```
.llm-kb/wiki/articles/
  index.md                          ← concept catalog with one-line descriptions
  bns-2023-overview.md              ← what it is, structure, key changes
  murder-and-homicide.md            ← Clauses 99-106, old vs new
  mob-lynching.md                   ← Clause 101(2), new provision
  electronic-evidence.md            ← Section 65B / BSB comparison
  organised-crime.md                ← Clauses 109-110, new
  sedition-removal.md               ← 124A removed, what replaces it
  offences-against-women.md         ← Chapter V, new protections
  ...
```

**Each article contains:**
```markdown
# Mob Lynching — BNS 2023, Clause 101(2)

## Overview
First-ever explicit criminalisation of mob lynching in Indian law...

## The Provision
When a group of 5+ persons acting in concert commits murder
on discriminatory grounds (race, caste, community, sex, etc.)...

## Punishment
- Death, OR life imprisonment, OR minimum 7 years + fine
- All members equally liable

## Comparison with IPC
IPC had no equivalent. Mob killings prosecuted under general S.302...

## Related Articles
- [[murder-and-homicide]] — general murder provisions
- [[bns-2023-overview]] — the full new code
- [[offences-against-women]] — other enhanced protections

*Sources: indian penal code - new.md (p.137), Annotated comparison (p.15)*
```

**How it works:**
1. Agent reads index.md to understand all sources
2. Agent reads each source (or first ~2000 chars for large files)
3. Agent identifies 10-30 key concepts across all sources
4. Agent writes one article per concept with cross-references
5. Agent writes articles/index.md catalog

**Implementation:**
- New command: `llm-kb compile` (or `llm-kb compile --folder ./docs`)
- Uses createAgentSession with read + write tools
- AGENTS.md instructs the agent on article format, backlinks, source citations
- Model: Sonnet (needs strong reasoning to synthesise across sources)

**Definition of done:**
- [ ] `llm-kb compile` reads all sources and writes articles/ directory
- [ ] articles/index.md is a concept catalog with one-line descriptions
- [ ] Each article has: overview, key details, source citations, related links
- [ ] Articles are cross-referenced with [[article-name]] backlinks

---

### Slice 2: Query uses articles

**What:** When articles/ exists, the agent reads articles/index.md instead of source-index.
It drills into specific articles rather than raw source files.

**The navigation flow:**
```
Agent reads articles/index.md (concept catalog)
  → Finds "mob-lynching.md" is relevant
  → Reads articles/mob-lynching.md (small, focused, pre-synthesised)
  → Answers instantly with cross-references
  → NO raw source files read
```

**Implementation:**
- Update buildQueryAgents() in query.ts
- If articles/index.md exists: inject it into AGENTS.md, tell agent to use articles
- Fallback: if no articles, use current source-index + wiki.md behaviour

**Definition of done:**
- [ ] Agent reads articles/index.md when available
- [ ] Agent navigates to specific articles, not source files
- [ ] Falls back to source-index when articles/ doesn't exist

---

### Slice 3: Auto-compile on first run

**What:** If `articles/` doesn't exist when `llm-kb run` starts, compile automatically.

**Flow:**
```
llm-kb run ./docs
  Scanning...
  9 parsed

  Building index... (haiku)
  Index built.

  Compiling knowledge articles... (sonnet)     ← NEW
  12 articles written to .llm-kb/wiki/articles/

  Ready. Ask a question...
```

**Skip logic (like index):**
- If articles/ exists AND is newer than all source files → skip
- If any source is newer → recompile incrementally

**Definition of done:**
- [ ] First run auto-compiles articles
- [ ] Subsequent runs skip if up to date
- [ ] Status command shows article count

---

### Slice 4: Incremental article updates

**What:** When a new file is dropped in, don't recompile everything.
Update only the 2-3 articles affected by the new content.

**Farza's quote:**
> "The most magical thing now is as I add new things, the system updates
> 2-3 different articles where it feels the context belongs, or just
> creates a new article. Like a super genius librarian."

**Flow:**
```
User drops "new-amendment-2024.pdf" into the folder
  → Watcher: parse PDF → sources/new-amendment-2024.md
  → Watcher: re-index (haiku)
  → Watcher: read new source + articles/index.md
  → Agent: "This affects mob-lynching.md and bns-2023-overview.md"
  → Agent: updates those 2 articles + creates new-amendments-2024.md
  → Agent: updates articles/index.md catalog
```

**Implementation:**
- Update watcher.ts: after re-index, trigger incremental article update
- Agent reads: new source file + articles/index.md
- Agent decides: which articles to update, whether to create new ones
- Uses Sonnet (needs reasoning about where new content fits)

**Definition of done:**
- [ ] New file → parse → re-index → update relevant articles
- [ ] Agent updates 2-3 existing articles where content fits
- [ ] Agent creates new article if topic is genuinely new
- [ ] articles/index.md updated with any new entries

---

### Slice 5: Eval — session analysis + article refinement

**What:** Analyze session files to find quality issues and wiki gaps.
Then fix the articles automatically.

**Input:** `.llm-kb/sessions/*.jsonl` (raw conversation data)

**What eval checks:**

```
CORRECTNESS
  - Citation validity: does the source text support the claim?
  - Consistency: does the answer contradict the sources?
  
PERFORMANCE
  - Query time breakdown: wiki hit vs file reads
  - Most-read source files (candidates for better articles)
  - Wasted reads: files read but not cited
  
WIKI GAPS
  - Questions that needed source files but should be in articles
  - Articles that are incomplete (queries needed to read past them)
  - Missing articles (topics asked about with no article)
  
INDEX ISSUES
  - Wrong file reads: agent read irrelevant files (bad index summary)
  - Redundant reads: same file read multiple times
```

**Output:** eval-report.md + automatic article patches

```markdown
# Eval Report — 2026-04-06

## Summary
15 sessions · 3 issues · 4 wiki gaps · estimated 120s saveable

## 🔴 Correctness Issues
1. Article "sedition-removal.md" says "retained" — source says "removed"
   → AUTO-FIX: patched article

## 🟡 Wiki Gaps (auto-filled)
1. "Electronic evidence certification" — asked 4x, no article
   → CREATED: articles/electronic-evidence-certification.md
2. "CrPC comparison" — asked 3x, article was incomplete
   → UPDATED: articles/crpc-comparison.md with missing sections

## 🟢 Performance Insights
- Wiki hit rate: 53% → 78% after gap fixes (estimated)
- Most-read source: indian-penal-code-new.md (12 reads)
  → Already well-covered by articles (reads are for exact quotes)
- Wasted reads: 8 across 15 sessions (32% waste rate)
```

**Implementation:**
- New command: `llm-kb eval`
- Reads session JSONL files (full conversation data)
- Code: extracts metrics (timing, file reads, citations)
- LLM judge (Haiku): checks citation validity, identifies gaps
- LLM writer (Haiku): patches articles with fixes
- Writes eval-report.md

**Definition of done:**
- [ ] `llm-kb eval` reads sessions and writes eval-report.md
- [ ] Flags: citation issues, consistency problems
- [ ] Identifies: wiki gaps, performance bottlenecks
- [ ] Auto-creates/patches articles for wiki gaps
- [ ] Reports estimated time savings

---

### Slice 6: The complete flywheel

With all slices done, the full flywheel:

```
         ┌──────────────┐
         │  COMPILE      │ Proactive: articles from all sources
         │  (once/incr)  │
         └──────┬────────┘
                │
                ▼
    ┌───────────────────────┐
    │  ARTICLES             │ Concept-organized, cross-referenced
    │  articles/index.md    │ Agent navigates concepts, not files
    │  articles/*.md        │
    └───────────┬───────────┘
                │
                ▼
    ┌───────────────────────┐
    │  QUERY                │ User asks question
    │  → reads article      │ Agent reads 1 small article, not 5 large sources
    │  → instant answer     │ Sessions logged
    └───────────┬───────────┘
                │
                ▼
    ┌───────────────────────┐
    │  EVAL                 │ Analyzes sessions
    │  → finds gaps         │ Creates missing articles
    │  → fixes errors       │ Patches wrong articles
    │  → measures speed     │ Reports optimization opportunities
    └───────────┬───────────┘
                │
                ▼
    ┌───────────────────────┐
    │  NEW FILE DROPPED     │ Watcher detects new source
    │  → incremental update │ Updates 2-3 relevant articles
    │  → index updated      │ New knowledge integrated
    └───────────┬───────────┘
                │
                └──────────── back to QUERY (faster every cycle)
```

**The compounding effect:**
- Day 1: compile articles from 9 PDFs → 15 articles
- Day 2: 10 queries → eval finds 3 gaps → 3 articles added/fixed
- Day 3: new PDF dropped → 2 articles updated
- Day 4: 20 queries → 90% answered from articles (2s avg vs 25s)
- Day 5: eval shows 95% wiki hit rate, 0 citation errors

---

## Build Order

| Slice | What | Effort | Priority |
|---|---|---|---|
| 1 | `llm-kb compile` | 2-3 hrs | 🔴 Do first |
| 2 | Query reads articles | 30 min | 🔴 Immediate follow-up |
| 3 | Auto-compile on first run | 15 min | 🟡 Quick win |
| 4 | Incremental article updates | 1-2 hrs | 🟡 This week |
| 5 | `llm-kb eval` | 2-3 hrs | 🟡 This week |
| 6 | Full flywheel verification | Testing | 🟢 After all slices |

---

*Phase 4 spec written April 6, 2026. DeltaXY.*
*Inspired by Farzapedia (@FarzaTV) — Karpathy called it the best implementation of the LLM wiki pattern.*
