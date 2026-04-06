import { describe, it, expect } from "vitest";
import { MarkdownStream } from "../src/md-stream.js";

describe("MarkdownStream", () => {
  describe("non-TTY (passthrough)", () => {
    it("returns chunks unchanged", () => {
      const md = new MarkdownStream(false);
      expect(md.push("**bold**")).toBe("**bold**");
      expect(md.push("# Header\n")).toBe("# Header\n");
    });
  });

  describe("TTY mode", () => {
    it("renders bold text", () => {
      const md = new MarkdownStream(true);
      const out = md.push("**hello**\n");
      expect(out).not.toContain("**");
      expect(out).toContain("hello");
    });

    it("renders italic text", () => {
      const md = new MarkdownStream(true);
      const out = md.push("*world*\n");
      expect(out).not.toContain("*world*");
      expect(out).toContain("world");
    });

    it("renders inline code", () => {
      const md = new MarkdownStream(true);
      const out = md.push("`code`\n");
      expect(out).not.toContain("`");
      expect(out).toContain("code");
    });

    it("renders headers without # symbols", () => {
      const md = new MarkdownStream(true);
      const out = md.push("## Section Title\n");
      expect(out).not.toContain("##");
      expect(out).toContain("Section Title");
    });

    it("renders bullet points with •", () => {
      const md = new MarkdownStream(true);
      const out = md.push("- item one\n");
      expect(out).toContain("•");
      expect(out).toContain("item one");
      expect(out).not.toMatch(/^- /m);
    });

    it("renders horizontal rules as ─", () => {
      const md = new MarkdownStream(true);
      const out = md.push("---\n");
      expect(out).toContain("─");
      expect(out).not.toContain("---");
    });

    it("renders block quotes with │", () => {
      const md = new MarkdownStream(true);
      const out = md.push("> quoted text\n");
      expect(out).toContain("│");
      expect(out).toContain("quoted text");
    });

    it("handles incomplete patterns by buffering", () => {
      const md = new MarkdownStream(true);
      // Push "**bo" — bold is incomplete, should buffer
      const out1 = md.push("**bo");
      // Push "ld**\n" — completes the bold
      const out2 = md.push("ld**\n");
      const combined = out1 + out2;
      expect(combined).toContain("bold");
      expect(combined).not.toContain("**");
    });

    it("flushes remaining buffer on end()", () => {
      const md = new MarkdownStream(true);
      // Push incomplete bold — gets buffered
      const out1 = md.push("**unfin");
      expect(out1).toBe(""); // buffered, not yet flushed
      const out2 = md.end();
      expect(out2).toContain("unfin"); // force-flushed
    });

    it("renders table separator rows as dim", () => {
      const md = new MarkdownStream(true);
      const out = md.push("|---|---|\n");
      expect(out).toContain("---|---");
    });

    it("renders links by showing label and dim URL", () => {
      const md = new MarkdownStream(true);
      const out = md.push("[Click here](https://example.com)\n");
      expect(out).toContain("Click here");
      expect(out).toContain("example.com");
      expect(out).not.toContain("[Click here]");
    });
  });
});
