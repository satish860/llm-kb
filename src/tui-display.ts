import {
  TUI, Container, Spacer, Text, Markdown, ProcessTerminal,
  type MarkdownTheme, type Component, Input,
} from "@mariozechner/pi-tui";
import chalk from "chalk";

// ── Markdown theme ──────────────────────────────────────────────────────────

function createMarkdownTheme(): MarkdownTheme {
  return {
    heading:         (t) => chalk.bold(t),
    link:            (t) => chalk.cyan(t),
    linkUrl:         (t) => chalk.dim(t),
    code:            (t) => chalk.cyan(t),
    codeBlock:       (t) => chalk.dim(t),
    codeBlockBorder: (t) => chalk.dim(t),
    quote:           (t) => chalk.italic(t),
    quoteBorder:     (t) => chalk.dim(t),
    hr:              (t) => chalk.dim(t),
    listBullet:      (t) => chalk.dim(t),
    bold:            (t) => chalk.bold(t),
    italic:          (t) => chalk.italic(t),
    underline:       (t) => chalk.underline(t),
    strikethrough:   (t) => chalk.strikethrough(t),
  };
}

const mdTheme = createMarkdownTheme();

// ── Helper components ───────────────────────────────────────────────────────

function dimText(text: string, px = 1, py = 0): Text {
  return new Text(chalk.dim(text), px, py);
}

/** Horizontal rule that spans full render width */
class HRule implements Component {
  private colorFn: (s: string) => string;
  constructor(colorFn?: (s: string) => string) {
    this.colorFn = colorFn ?? chalk.dim;
  }
  invalidate() {}
  render(width: number): string[] {
    return [this.colorFn("\u2500".repeat(width))];
  }
}

// ── Chat display ────────────────────────────────────────────────────────────

export class ChatDisplay {
  private tui: TUI;
  private terminal: ProcessTerminal;
  private messageArea: Container;
  private inputArea: Container;
  private input: Input;

  // Current response components (reset per prompt)
  private currentResponse: Container | null = null;
  private thinkingText: Text | null = null;
  private toolsContainer: Container | null = null;
  private answerContainer: Container | null = null;
  private answerMd: Markdown | null = null;

  private filesReadCount = 0;
  private shownToolCalls = new Set<string>();
  private startTime = Date.now();

  onSubmit?: (text: string) => void;
  onExit?: () => void;

  constructor() {
    this.terminal = new ProcessTerminal();
    this.tui = new TUI(this.terminal);

    // Layout: messages + separator + input + separator
    this.messageArea = new Container();
    this.tui.addChild(this.messageArea);

    this.inputArea = new Container();
    this.inputArea.addChild(new HRule((s) => chalk.hex("#c678dd")(s)));

    this.input = new Input();
    this.input.onSubmit = (text) => {
      if (text.trim() && this.onSubmit) {
        this.addUserMessage(text.trim());
        this.onSubmit(text.trim());
      }
      this.input.setValue("");
    };
    this.inputArea.addChild(this.input);
    this.inputArea.addChild(new HRule((s) => chalk.hex("#c678dd")(s)));

    this.tui.addChild(this.inputArea);
    this.tui.setFocus(this.input);
  }

  start(): void {
    this.tui.start();

    // Ctrl+C / Ctrl+D handler — TUI captures raw input so SIGINT doesn't fire
    this.tui.addInputListener((data) => {
      if (data === "\x03" || data === "\x04") { // Ctrl+C or Ctrl+D
        this.stop();
        if (this.onExit) this.onExit();
        else process.exit(0);
        return { consume: true };
      }
      return undefined;
    });

    this.tui.requestRender();
  }

  stop(): void {
    this.tui.stop();
  }

  addUserMessage(text: string): void {
    this.messageArea.addChild(new Spacer(1));
    this.messageArea.addChild(new Text(chalk.bold(text), 1, 0));
    this.tui.requestRender();
  }

  // ── Per-prompt lifecycle ────────────────────────────────────────────────

  beginResponse(modelName: string): void {
    this.filesReadCount = 0;
    this.shownToolCalls = new Set();
    this.startTime = Date.now();
    this.thinkingText = null;
    this.toolsContainer = null;
    this.answerContainer = null;
    this.answerMd = null;

    this.currentResponse = new Container();
    this.currentResponse.addChild(new Spacer(1));
    this.currentResponse.addChild(dimText(`\u27e1 ${modelName}`));

    // Pre-create sections in fixed order: tools → answer
    // Components are added to these containers as events arrive
    this.toolsContainer = new Container();
    this.currentResponse.addChild(this.toolsContainer);

    this.answerContainer = new Container();
    this.currentResponse.addChild(this.answerContainer);

    this.messageArea.addChild(this.currentResponse);
    this.tui.requestRender();
  }

  appendThinking(text: string): void {
    if (!this.currentResponse) return;
    if (!this.thinkingText) {
      this.currentResponse.addChild(new Spacer(1));
      this.currentResponse.addChild(dimText("\u25b8 Thinking"));
      this.thinkingText = new Text(chalk.dim(chalk.italic(text)), 2, 0);
      this.currentResponse.addChild(this.thinkingText);
    } else {
      const prev = (this.thinkingText as any).text ?? "";
      this.thinkingText.setText(chalk.dim(chalk.italic(prev.replace(/\x1b\[[0-9;]*m/g, "") + text)));
    }
    this.tui.requestRender();
  }

  addToolCall(toolCallId: string, label: string, toolName: string): void {
    if (!this.toolsContainer || this.shownToolCalls.has(toolCallId)) return;
    this.shownToolCalls.add(toolCallId);
    if (toolName === "read") this.filesReadCount++;

    this.toolsContainer.addChild(dimText(`  \u25b8 ${label}`));
    this.tui.requestRender();
  }

  beginAnswer(): void {
    if (!this.answerContainer || this.answerMd) return;

    this.answerContainer.addChild(new Spacer(1));
    this.answerContainer.addChild(new HRule());
    this.answerContainer.addChild(new Spacer(1));

    this.answerMd = new Markdown("", 1, 0, mdTheme);
    this.answerContainer.addChild(this.answerMd);
    this.tui.requestRender();
  }

  appendAnswer(text: string): void {
    if (!this.answerMd) this.beginAnswer();
    const prev = (this.answerMd as any).text ?? "";
    this.answerMd!.setText(prev + text);
    this.tui.requestRender();
  }

  showCompletion(): void {
    if (!this.currentResponse) return;
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const source = this.filesReadCount > 0
      ? `${this.filesReadCount} file${this.filesReadCount !== 1 ? "s" : ""} read`
      : "wiki";
    const stats = `\u2500\u2500 ${elapsed}s \u00b7 ${source} `;

    // Custom component that fills remaining width with ─
    const completion: Component = {
      invalidate() {},
      render(width: number) {
        const pad = Math.max(0, width - stats.length);
        return [chalk.dim(stats + "\u2500".repeat(pad))];
      },
    };

    this.currentResponse.addChild(new Spacer(1));
    this.currentResponse.addChild(completion);
    this.currentResponse = null;
    this.tui.requestRender();
  }

  enableInput(): void {
    this.tui.setFocus(this.input);
    this.tui.requestRender();
  }

  disableInput(): void {
    this.tui.setFocus(null);
  }
}
