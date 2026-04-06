import chalk from "chalk";

/**
 * Streaming markdown renderer for terminal output.
 *
 * Processes text_delta chunks and applies ANSI styling as patterns complete.
 * Handles: **bold**, *italic*, `code`, ## headers, --- hr, - bullets, | tables.
 *
 * Not a full markdown parser — just enough for readable CLI output.
 */
export class MarkdownStream {
  private buffer = "";
  private isTTY: boolean;
  private lineStart = true; // are we at the start of a new line?

  constructor(isTTY = false) {
    this.isTTY = isTTY;
  }

  /** Feed a text_delta chunk. Returns styled string ready for process.stdout.write(). */
  push(chunk: string): string {
    if (!this.isTTY) return chunk; // no styling when piped

    this.buffer += chunk;
    return this.flush();
  }

  /** Flush remaining buffer (call on text_end). */
  end(): string {
    if (!this.isTTY) return "";
    const out = this.flush(true);
    this.buffer = "";
    this.lineStart = true;
    return out;
  }

  private flush(final = false): string {
    let out = "";

    while (this.buffer.length > 0) {
      // Process complete lines first
      const nlIdx = this.buffer.indexOf("\n");
      if (nlIdx === -1 && !final) {
        // No complete line yet — check if we have enough for inline styling
        const inlined = this.tryInlineStyles(this.buffer, false);
        if (inlined !== null) {
          out += inlined;
          this.buffer = "";
        }
        break; // wait for more data
      }

      if (nlIdx === -1 && final) {
        // Final flush — process whatever remains
        out += this.processLine(this.buffer, false);
        this.buffer = "";
        break;
      }

      // We have a complete line
      const line = this.buffer.slice(0, nlIdx);
      this.buffer = this.buffer.slice(nlIdx + 1);
      out += this.processLine(line, true) + "\n";
      this.lineStart = true;
    }

    return out;
  }

  private processLine(line: string, complete: boolean): string {
    if (!this.lineStart) {
      return this.applyInline(line);
    }

    const trimmed = line.trimStart();

    // Horizontal rule
    if (/^-{3,}$/.test(trimmed) || /^\*{3,}$/.test(trimmed)) {
      const cols = process.stdout.columns || 80;
      return chalk.dim("─".repeat(Math.min(cols, 60)));
    }

    // Headers
    const headerMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const text = this.applyInline(headerMatch[2]);
      if (level <= 2) return chalk.bold(text);
      return chalk.bold(text);
    }

    // Bullet points
    const bulletMatch = trimmed.match(/^[-*+]\s+(.*)$/);
    if (bulletMatch) {
      const indent = line.length - trimmed.length;
      const prefix = " ".repeat(indent) + chalk.dim("•") + " ";
      return prefix + this.applyInline(bulletMatch[1]);
    }

    // Numbered lists
    const numMatch = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
    if (numMatch) {
      const indent = line.length - trimmed.length;
      return " ".repeat(indent) + chalk.dim(numMatch[1] + ".") + " " + this.applyInline(numMatch[2]);
    }

    // Table rows
    if (trimmed.startsWith("|")) {
      // Separator row (|---|---|)
      if (/^\|[\s\-:|]+\|$/.test(trimmed)) {
        return chalk.dim(trimmed);
      }
      return this.applyInline(line);
    }

    // Block quotes
    if (trimmed.startsWith(">")) {
      const content = trimmed.replace(/^>\s*/, "");
      return chalk.dim("│ ") + chalk.italic(this.applyInline(content));
    }

    this.lineStart = false;
    return this.applyInline(line);
  }

  private tryInlineStyles(text: string, complete: boolean): string | null {
    // Don't process incomplete bold/italic patterns
    if (!complete) {
      const openBold = (text.match(/\*\*/g) || []).length;
      const openItalic = (text.match(/(?<!\*)\*(?!\*)/g) || []).length;
      const openCode = (text.match(/`/g) || []).length;
      if (openBold % 2 !== 0 || openCode % 2 !== 0) return null;
    }
    return this.applyInline(text);
  }

  private applyInline(text: string): string {
    if (!this.isTTY) return text;

    // Code (backticks) — must be before bold/italic to avoid conflicts
    text = text.replace(/`([^`]+)`/g, (_, code) => chalk.cyan(code));

    // Bold + italic
    text = text.replace(/\*\*\*([^*]+)\*\*\*/g, (_, t) => chalk.bold.italic(t));

    // Bold
    text = text.replace(/\*\*([^*]+)\*\*/g, (_, t) => chalk.bold(t));

    // Italic
    text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, t) => chalk.italic(t));

    // Strikethrough
    text = text.replace(/~~([^~]+)~~/g, (_, t) => chalk.strikethrough(t));

    // Links [text](url) → text (dim url)
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) =>
      `${label} ${chalk.dim(`(${url})`)}`
    );

    // Emoji shortcodes (just pass through — terminal handles unicode)

    return text;
  }
}
