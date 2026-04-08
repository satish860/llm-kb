import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeGuidelines } from "../src/eval.js";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("writeGuidelines", () => {
  let tempDir: string;
  let guidelinesPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "llm-kb-test-"));
    guidelinesPath = join(tempDir, "guidelines.md");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const evalV1 = [
    "## Eval Insights (auto-generated 2026-04-06)",
    "",
    "### Wiki Gaps — add to wiki when users ask about these topics",
    "- Reserve requirements",
    "- Engine types",
    "",
    "### Performance",
    "- Wiki hit rate: 66% (target: 80%+)",
    "- Avg query time: 8.3s",
    "",
  ].join("\n");

  const evalV2 = [
    "## Eval Insights (auto-generated 2026-04-07)",
    "",
    "### Behaviour Fixes",
    "- Double-check clause numbers against source text.",
    "",
    "### Performance",
    "- Wiki hit rate: 82% (target: 80%+)",
    "- Avg query time: 3.1s",
    "",
  ].join("\n");

  const userRules = [
    "## My Rules",
    "",
    "- Always use Hindi transliterations for legal terms",
    "- Respond in bullet points for legal questions",
    "",
  ].join("\n");

  it("creates file from scratch when it doesn't exist", async () => {
    await writeGuidelines(guidelinesPath, evalV1);
    const content = await readFile(guidelinesPath, "utf-8");
    expect(content).toBe(evalV1);
  });

  it("replaces eval section, preserves user rules", async () => {
    // First write: eval v1 + user rules
    const { writeFile } = await import("node:fs/promises");
    await writeFile(guidelinesPath, evalV1 + "\n" + userRules, "utf-8");

    // Second write: eval v2 should replace v1, keep user rules
    await writeGuidelines(guidelinesPath, evalV2);
    const content = await readFile(guidelinesPath, "utf-8");

    expect(content).toContain("2026-04-07");
    expect(content).not.toContain("2026-04-06");
    expect(content).toContain("## My Rules");
    expect(content).toContain("Hindi transliterations");
  });

  it("prepends eval section when file has only user rules", async () => {
    // File exists with only user rules, no eval section
    const { writeFile } = await import("node:fs/promises");
    await writeFile(guidelinesPath, userRules, "utf-8");

    await writeGuidelines(guidelinesPath, evalV1);
    const content = await readFile(guidelinesPath, "utf-8");

    // Eval section comes first, user rules preserved
    const evalPos = content.indexOf("## Eval Insights");
    const userPos = content.indexOf("## My Rules");
    expect(evalPos).toBeLessThan(userPos);
    expect(content).toContain("Hindi transliterations");
    expect(content).toContain("Wiki hit rate: 66%");
  });

  it("handles back-to-back eval runs (no user rules)", async () => {
    await writeGuidelines(guidelinesPath, evalV1);
    await writeGuidelines(guidelinesPath, evalV2);
    const content = await readFile(guidelinesPath, "utf-8");

    expect(content).toContain("2026-04-07");
    expect(content).not.toContain("2026-04-06");
    expect(content).toContain("3.1s");
  });
});
