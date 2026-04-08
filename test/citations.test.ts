import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildTextRun, matchCitation, parseCitations } from "../src/citations.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── parseCitations ──────────────────────────────────────────────────────────

describe("parseCitations", () => {
  it("extracts citations from a CITATIONS block", () => {
    const response = `The marriage date is 6 February 2013. [1]

CITATIONS:
[1] file: "list-of-dates.md", page: 1, quote: "6 February 2013 Parties got married"
[2] file: "judgment.md", page: 12, quote: "marriage was solemnized on 6 February"`;

    const result = parseCitations(response);
    expect(result.answer).toBe("The marriage date is 6 February 2013. [1]");
    expect(result.citations).toHaveLength(2);
    expect(result.citations[0].file).toBe("list-of-dates.md");
    expect(result.citations[0].page).toBe(1);
    expect(result.citations[1].page).toBe(12);
  });

  it("returns full response when no CITATIONS block", () => {
    const response = "Just a plain answer.";
    const result = parseCitations(response);
    expect(result.answer).toBe("Just a plain answer.");
    expect(result.citations).toHaveLength(0);
  });
});

// ── buildTextRun ────────────────────────────────────────────────────────────

describe("buildTextRun", () => {
  it("concatenates items on the same line", () => {
    const items = [
      { text: "Lease", x: 100, y: 340, width: 45, height: 14 },
      { text: "Start", x: 150, y: 340, width: 38, height: 14 },
      { text: "Date:", x: 193, y: 340, width: 40, height: 14 },
    ];
    const run = buildTextRun(items);
    expect(run.text).toBe("Lease Start Date:");
    expect(run.segments).toHaveLength(3);
  });

  it("splits into lines by y-coordinate", () => {
    const items = [
      { text: "Line", x: 100, y: 100, width: 30, height: 14 },
      { text: "One", x: 135, y: 100, width: 25, height: 14 },
      { text: "Line", x: 100, y: 130, width: 30, height: 14 },
      { text: "Two", x: 135, y: 130, width: 25, height: 14 },
    ];
    const run = buildTextRun(items);
    expect(run.text).toBe("Line One\nLine Two");
  });

  it("handles items within y-tolerance as same line", () => {
    const items = [
      { text: "Hello", x: 100, y: 100, width: 40, height: 14 },
      { text: "World", x: 150, y: 102, width: 40, height: 14 },
    ];
    const run = buildTextRun(items);
    expect(run.text).toBe("Hello World");
  });

  it("skips empty text items", () => {
    const items = [
      { text: "Hello", x: 100, y: 100, width: 40, height: 14 },
      { text: "", x: 145, y: 100, width: 5, height: 14 },
      { text: "  ", x: 150, y: 100, width: 5, height: 14 },
      { text: "World", x: 155, y: 100, width: 40, height: 14 },
    ];
    const run = buildTextRun(items);
    expect(run.text).toBe("Hello World");
  });

  it("returns empty for no items", () => {
    const run = buildTextRun([]);
    expect(run.text).toBe("");
    expect(run.segments).toHaveLength(0);
  });

  it("adds extra space for large gaps (column separators)", () => {
    const items = [
      { text: "Date", x: 100, y: 100, width: 30, height: 14 },
      { text: "Event", x: 300, y: 100, width: 40, height: 14 },
    ];
    const run = buildTextRun(items);
    expect(run.text).toBe("Date  Event");
  });
});

// ── matchCitation ───────────────────────────────────────────────────────────

describe("matchCitation", () => {
  let tmpDir: string;

  const makeBboxJson = (textItems: Array<{ text: string; x: number; y: number; width: number; height: number }>, page = 1) => ({
    source: "test.pdf",
    totalPages: 1,
    pages: [{
      page,
      width: 595,
      height: 842,
      textItems,
    }],
  });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "cite-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("exact match returns confidence 1.0 with bounding boxes", async () => {
    const items = [
      { text: "Lease", x: 100, y: 340, width: 45, height: 14 },
      { text: "Start", x: 150, y: 340, width: 38, height: 14 },
      { text: "Date:", x: 193, y: 340, width: 40, height: 14 },
      { text: "15", x: 238, y: 340, width: 15, height: 14 },
      { text: "March", x: 258, y: 340, width: 40, height: 14 },
      { text: "2019", x: 303, y: 340, width: 30, height: 14 },
    ];
    await writeFile(join(tmpDir, "test.json"), JSON.stringify(makeBboxJson(items)));

    const result = await matchCitation(
      { file: "test.md", page: 1, quote: "Lease Start Date: 15 March 2019" },
      tmpDir
    );

    expect(result.matched).toBe(true);
    expect(result.confidence).toBe(1.0);
    expect(result.boundingBoxes.length).toBeGreaterThan(0);
    expect(result.mergedRect).not.toBeNull();
    expect(result.mergedRect!.x).toBe(100);
  });

  it("normalized match handles case and whitespace differences", async () => {
    const items = [
      { text: "Lease", x: 100, y: 340, width: 45, height: 14 },
      { text: "Start", x: 150, y: 340, width: 38, height: 14 },
      { text: "Date", x: 193, y: 340, width: 40, height: 14 },
    ];
    await writeFile(join(tmpDir, "test.json"), JSON.stringify(makeBboxJson(items)));

    const result = await matchCitation(
      { file: "test.md", page: 1, quote: "lease  start  date" },
      tmpDir
    );

    expect(result.matched).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("fuzzy match handles minor differences", async () => {
    const items = [
      { text: "Certificate", x: 100, y: 200, width: 80, height: 14 },
      { text: "of", x: 185, y: 200, width: 15, height: 14 },
      { text: "Incorporation", x: 205, y: 200, width: 90, height: 14 },
    ];
    await writeFile(join(tmpDir, "test.json"), JSON.stringify(makeBboxJson(items)));

    const result = await matchCitation(
      { file: "test.md", page: 1, quote: "Certficate of Incorporaton" },
      tmpDir
    );

    expect(result.matched).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.confidence).toBeLessThan(1.0);
  });

  it("returns not matched when quote not found", async () => {
    const items = [
      { text: "Hello", x: 100, y: 100, width: 40, height: 14 },
      { text: "World", x: 150, y: 100, width: 40, height: 14 },
    ];
    await writeFile(join(tmpDir, "test.json"), JSON.stringify(makeBboxJson(items)));

    const result = await matchCitation(
      { file: "test.md", page: 1, quote: "Something completely different that is not in the text at all" },
      tmpDir
    );

    expect(result.matched).toBe(false);
    expect(result.confidence).toBe(0);
  });

  it("returns not matched when json file missing", async () => {
    const result = await matchCitation(
      { file: "nonexistent.md", page: 1, quote: "test" },
      tmpDir
    );

    expect(result.matched).toBe(false);
  });

  it("searches all pages when page is 0", async () => {
    const data = {
      source: "test.pdf",
      totalPages: 2,
      pages: [
        { page: 1, width: 595, height: 842, textItems: [
          { text: "Page", x: 100, y: 100, width: 30, height: 14 },
          { text: "One", x: 135, y: 100, width: 25, height: 14 },
        ]},
        { page: 2, width: 595, height: 842, textItems: [
          { text: "Target", x: 100, y: 100, width: 40, height: 14 },
          { text: "Quote", x: 145, y: 100, width: 40, height: 14 },
          { text: "Here", x: 190, y: 100, width: 30, height: 14 },
        ]},
      ],
    };
    await writeFile(join(tmpDir, "test.json"), JSON.stringify(data));

    const result = await matchCitation(
      { file: "test.md", page: 0, quote: "Target Quote Here" },
      tmpDir
    );

    expect(result.matched).toBe(true);
    expect(result.page).toBe(2);
  });

  it("mergedRect covers all matched bounding boxes", async () => {
    const items = [
      { text: "First", x: 100, y: 100, width: 40, height: 14 },
      { text: "Second", x: 145, y: 100, width: 50, height: 14 },
      { text: "Third", x: 200, y: 100, width: 40, height: 14 },
    ];
    await writeFile(join(tmpDir, "test.json"), JSON.stringify(makeBboxJson(items)));

    const result = await matchCitation(
      { file: "test.md", page: 1, quote: "First Second Third" },
      tmpDir
    );

    expect(result.mergedRect).not.toBeNull();
    expect(result.mergedRect!.x).toBe(100);
    expect(result.mergedRect!.width).toBe(140);
  });
});
