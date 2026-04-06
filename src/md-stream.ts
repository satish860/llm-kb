import chalk from "chalk";

/**
 * Streaming markdown renderer for terminal output.
 *
 * Processes text_delta chunks and applies ANSI styling as patterns complete.
 * Handles: **bold**, *italic*, `code`, ## headers, --- hr, • bullets,
 * > blockquotes, [links](url), ~~strikethrough~~, | tables.
 */
export class MarkdownStream {
  private buffer = "";
  private isTTY: boolean;

  constructor(isTTY = false) {
    this.isTTY = isTTY;
  }

  /** Feed a text_delta chunk. Returns styled string ready for stdout. */
  push(chunk: string): string {
    if (!this.isTTY) return chunk;

    this.buffer += chunk;
    return this.drain(false);
  }

  /** Flush remaining buffer (call on text_end). */
  end(): string {
    if (!this.isTTY) return "";
    const out = this.drain(true);
    this.buffer = "";
    return out;
  }

  private drain(final: boolean): string {
    let out = "";

    while (true) {
      const nlIdx = this.buffer.indexOf("\n");

      if (nlIdx === -1) {
        if (final && this.buffer.length > 0) {
          // Final flush — render whatever's left
          out += this.renderLine(this.buffer);
          this.buffer = "";
        }
        // else: wait for more data (incomplete line)
        break;
      }

      // Complete line found — render it
      const line = this.buffer.slice(0, nlIdx);
      this.buffer = this.buffer.slice(nlIdx + 1);
      out += this.renderLine(line) + "\n";
    }

    return out;
  }

  /** Render a single complete line with block + inline styling. */
  private renderLine(line: string): string {
    const trimmed = line.trimStart();

    // Horizontal rule
    if (/^-{3,}\s*$/.test(trimmed) || /^\*{3,}\s*$/.test(trimmed)) {
      const cols = process.stdout.columns || 80;
      return chalk.dim("\u2500".repeat(Math.min(cols, 60)));
    }

    // Headers — strip # prefix, render bold
    const headerMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headerMatch) {
      const text = this.inline(headerMatch[2]);
      return "\n" + chalk.bold(text);
    }

    // Bullet points
    const bulletMatch = trimmed.match(/^[-*+]\s+(.*)$/);
    if (bulletMatch) {
      const indent = line.length - trimmed.length;
      return " ".repeat(indent) + chalk.dim("\u2022") + " " + this.inline(bulletMatch[1]);
    }

    // Numbered lists
    const numMatch = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
    if (numMatch) {
      const indent = line.length - trimmed.length;
      return " ".repeat(indent) + chalk.dim(numMatch[1] + ".") + " " + this.inline(numMatch[2]);
    }

    // Table separator row
    if (/^\|[\s\-:|]+\|$/.test(trimmed)) {
      return chalk.dim(trimmed);
    }

    // Table data row
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      return this.inline(line);
    }

    // Block quotes — support nested > > and inline formatting
    if (trimmed.startsWith(">")) {
      const content = trimmed.replace(/^>+\s*/, "");
      return chalk.dim("\u2502 ") + chalk.italic(this.inline(content));
    }

    return this.inline(line);
  }

  /** Apply inline markdown styling to text. */
  private inline(text: string): string {
    // Code spans (before bold/italic to avoid conflicts inside backticks)
    text = text.replace(/`([^`]+)`/g, (_, c) => chalk.cyan(c));

    // Bold + italic
    text = text.replace(/\*\*\*(.+?)\*\*\*/g, (_, t) => chalk.bold.italic(t));

    // Bold
    text = text.replace(/\*\*(.+?)\*\*/g, (_, t) => chalk.bold(t));

    // Italic (single * not adjacent to another *)
    text = text.replace(/(?<!\*)\*(.+?)\*(?!\*)/g, (_, t) => chalk.italic(t));

    // Strikethrough
    text = text.replace(/~~(.+?)~~/g, (_, t) => chalk.strikethrough(t));

    // Links
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) =>
      `${label} ${chalk.dim(`(${url})`)}`
    );

    return text;
  }
}
