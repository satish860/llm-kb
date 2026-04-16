#!/usr/bin/env node

import { Command } from "commander";
import { scan, summarize } from "./scan.js";
import { parsePDF } from "./pdf.js";
import { buildIndex } from "./indexer.js";
import { startWatcher } from "./watcher.js";
import { startSessionWatcher } from "./session-watcher.js";
import { query, createChat } from "./query.js";
import { runEval } from "./eval.js";
import { ChatDisplay } from "./tui-display.js";
import { resolveKnowledgeBase } from "./resolve-kb.js";
import { checkAuth, exitWithAuthError } from "./auth.js";
import { ensureConfig, loadConfig } from "./config.js";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
const VERSION = pkg.version;

const program = new Command();

program
  .name("llm-kb")
  .description("Drop files into a folder. Get a knowledge base you can query.")
  .version(VERSION);

program
  .command("run")
  .description("Scan, parse, index, and watch a folder")
  .argument("<folder>", "Path to your documents folder")
  .action(async (folder: string) => {
    console.log(`\n${chalk.bold("llm-kb")} v${VERSION}\n`);

    const auth = checkAuth();
    if (!auth.ok) exitWithAuthError();

    if (!existsSync(folder)) {
      console.error(chalk.red(`Error: Folder not found: ${folder}`));
      process.exit(1);
    }

    const root = resolve(folder);
    const config = await ensureConfig(root);

    console.log(`Scanning ${folder}...`);

    const files = await scan(folder);

    if (files.length === 0) {
      console.log(chalk.yellow("  No supported files found."));
      return;
    }

    const pdfs = files.filter((f) => f.ext === ".pdf");
    console.log(`  Found ${chalk.bold(files.length.toString())} files (${summarize(files)})`);
    if (pdfs.length === 0) return;

    const sourcesDir = join(root, ".llm-kb", "wiki", "sources");
    await mkdir(sourcesDir, { recursive: true });

    // Parse PDFs
    let parsed = 0;
    let skipped = 0;
    let failed = 0;
    const errors: { name: string; message: string }[] = [];

    for (let i = 0; i < pdfs.length; i++) {
      const pdf = pdfs[i];
      const progress = `  Parsing... ${i + 1}/${pdfs.length} \u2014 ${pdf.name}`;
      process.stdout.write(`\r${progress.padEnd(process.stdout.columns || 80)}`);
      try {
        const result = await parsePDF(join(root, pdf.path), sourcesDir);
        if (result.skipped) skipped++; else parsed++;
      } catch (err: any) {
        failed++;
        errors.push({ name: pdf.name, message: err.message });
      }
    }

    process.stdout.write(`\r${"".padEnd(process.stdout.columns || 80)}\r`);

    const parts: string[] = [];
    if (parsed > 0) parts.push(chalk.green(`${parsed} parsed`));
    if (skipped > 0) parts.push(chalk.dim(`${skipped} skipped (up to date)`));
    if (failed > 0) parts.push(chalk.red(`${failed} failed`));
    console.log(`  ${parts.join(", ")}`);
    for (const err of errors) console.log(chalk.red(`    \u2717 ${err.name} \u2014 ${err.message}`));

    // Build index — skip if up to date
    const indexFile = join(root, ".llm-kb", "wiki", "index.md");
    let indexUpToDate = false;
    if (parsed === 0 && existsSync(indexFile)) {
      try {
        const indexMtime = (await stat(indexFile)).mtimeMs;
        const sourceFiles = await readdir(sourcesDir);
        const mtimes = await Promise.all(sourceFiles.map((f) => stat(join(sourcesDir, f)).then((s) => s.mtimeMs)));
        indexUpToDate = mtimes.every((mt) => indexMtime >= mt);
      } catch {}
    }

    if (indexUpToDate) {
      console.log(chalk.dim(`\n  Index up to date.`));
    } else {
      console.log(`\n  Building index... ${chalk.dim(`(${config.indexModel})`)}`);
      try {
        await buildIndex(root, sourcesDir, undefined, auth.authStorage, config.indexModel);
        console.log(chalk.green(`  Index built: .llm-kb/wiki/index.md`));
      } catch (err: any) {
        console.error(chalk.red(`  Index failed: ${err.message}`));
      }
    }

    console.log(`\n  ${chalk.dim("Output:")} ${sourcesDir}`);

    // TUI chat
    const chatUI = new ChatDisplay();
    const { session, display, reloadSources } = await createChat(root, {
      authStorage: auth.authStorage,
      modelId: config.queryModel,
      tuiDisplay: chatUI,
    });

    // Start watchers — pass reloadSources so the chat picks up new files
    startWatcher({ folder: root, sourcesDir, authStorage: auth.authStorage, indexModel: config.indexModel, onSourcesChanged: reloadSources });
    startSessionWatcher(root);

    chatUI.onSubmit = (text) => {
      display.setQuestion(text);
      // Fire-and-forget — don't await, TUI must stay responsive
      session.prompt(text).catch(() => {});
    };

    chatUI.onExit = () => {
      display.flush().then(() => {
        session.dispose();
        process.exit(0);
      });
    };

    console.log(`\n${chalk.bold("Ready.")} Ask a question or drop files in to re-index.\n`);
    chatUI.start();
  });

program
  .command("query")
  .description("Ask a single question (non-interactive, stdout)")
  .argument("<question>", "Your question")
  .option("--folder <path>", "Path to document folder (auto-detects if omitted)")
  .option("--save", "Save the answer to wiki/outputs/ (research mode)")
  .action(async (question: string, options: { folder?: string; save?: boolean }) => {
    const auth = checkAuth();
    if (!auth.ok) exitWithAuthError();

    const root = resolveKnowledgeBase(options.folder || process.cwd());
    if (!root) {
      console.error(chalk.red("No knowledge base found. Run 'llm-kb run <folder>' first."));
      process.exit(1);
    }

    const config = await loadConfig(root);
    try {
      await query(root, question, {
        save: options.save,
        authStorage: auth.authStorage,
        modelId: config.queryModel,
      });
    } catch (err: any) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }
  });

program
  .command("eval")
  .description("Analyze sessions for quality issues, wiki gaps, and performance")
  .option("--folder <path>", "Path to document folder (auto-detects if omitted)")
  .option("--last <n>", "Only check last N sessions", parseInt)
  .action(async (options: { folder?: string; last?: number }) => {
    const auth = checkAuth();
    if (!auth.ok) exitWithAuthError();

    const root = resolveKnowledgeBase(options.folder || process.cwd());
    if (!root) {
      console.error(chalk.red("No knowledge base found. Run 'llm-kb run <folder>' first."));
      process.exit(1);
    }

    console.log(`\n${chalk.bold("llm-kb eval")}\n`);

    const result = await runEval(root, {
      authStorage: auth.authStorage,
      last: options.last,
      onProgress: (msg) => console.log(chalk.dim(`  ${msg}`)),
    });

    const { metrics, issues, wikiGaps } = result;
    const errors = issues.filter((i) => i.severity === "error").length;
    const warnings = issues.filter((i) => i.severity === "warning").length;

    console.log();
    console.log(`  ${chalk.bold("Results:")}`);
    console.log(`  Queries analyzed:  ${metrics.totalQAs}`);
    console.log(`  Wiki hit rate:     ${metrics.totalQAs > 0 ? Math.round(metrics.wikiHits / metrics.totalQAs * 100) : 0}%`);
    console.log(`  Wasted reads:      ${metrics.wastedReads}`);
    const cm = metrics.citations;
    const bboxPct = cm.totalCitations > 0 ? Math.round(cm.withBbox / cm.totalCitations * 100) : 0;
    console.log(`  Citations:         ${cm.totalCitations} total, ${chalk.green(`${cm.withBbox} with bbox`)}${cm.withoutBbox > 0 ? chalk.yellow(` ${cm.withoutBbox} without`) : ''} (${bboxPct}%)`);
    console.log(`  Issues:            ${errors > 0 ? chalk.red(`${errors} errors`) : chalk.green("0 errors")}  ${warnings > 0 ? chalk.yellow(`${warnings} warnings`) : chalk.dim("0 warnings")}`);
    console.log(`  Wiki gaps:         ${wikiGaps.length > 0 ? chalk.yellow(String(wikiGaps.length)) : chalk.green("0")}`);
    console.log();
    console.log(chalk.green(`  Report: .llm-kb/wiki/outputs/eval-report.md`));
    console.log();
  });

program
  .command("status")
  .description("Show knowledge base stats and current config")
  .option("--folder <path>", "Path to document folder (auto-detects if omitted)")
  .action(async (options: { folder?: string }) => {
    const root = resolveKnowledgeBase(options.folder || process.cwd());
    if (!root) {
      console.error(chalk.red("No knowledge base found. Run 'llm-kb run <folder>' first."));
      process.exit(1);
    }

    const auth = checkAuth();
    const config = await loadConfig(root);

    const sourcesDir  = join(root, ".llm-kb", "wiki", "sources");
    const indexFile   = join(root, ".llm-kb", "wiki", "index.md");
    const articlesDir = join(root, ".llm-kb", "wiki", "articles");
    const outputsDir  = join(root, ".llm-kb", "wiki", "outputs");

    let sourceCount = 0;
    try { sourceCount = (await readdir(sourcesDir)).filter((f) => f.endsWith(".md")).length; } catch {}

    let indexAge = "not built yet";
    try {
      const diffMin = Math.round((Date.now() - (await stat(indexFile)).mtimeMs) / 60000);
      indexAge = diffMin < 1 ? "just now" : diffMin < 60 ? `${diffMin} min ago` : `${Math.round(diffMin / 60)} hr ago`;
    } catch {}

    let outputCount = 0;
    try { outputCount = (await readdir(outputsDir)).filter((f) => f.endsWith(".md")).length; } catch {}

    console.log(`\n${chalk.bold("Knowledge Base Status")}`);
    console.log(`  ${chalk.dim("Folder:")}  ${root}`);
    console.log(`  ${chalk.dim("Sources:")} ${sourceCount > 0 ? `${sourceCount} parsed source${sourceCount !== 1 ? "s" : ""}` : chalk.yellow("none yet")}`);
    console.log(`  ${chalk.dim("Index:")}   ${indexAge}`);
    let articleCount = 0;
    try { articleCount = (await readdir(articlesDir)).filter((f) => f.endsWith(".md") && f !== "index.md").length; } catch {}

    if (articleCount > 0) console.log(`  ${chalk.dim("Articles:")} ${articleCount} compiled`);
    if (outputCount > 0) console.log(`  ${chalk.dim("Outputs:")} ${outputCount} saved answer${outputCount !== 1 ? "s" : ""}`);
    console.log(`  ${chalk.dim("Models:")}  ${chalk.cyan(config.queryModel)} ${chalk.dim("(query)")}  ${chalk.cyan(config.indexModel)} ${chalk.dim("(index)")}`);
    console.log(`  ${chalk.dim("Auth:")}    ${auth.ok ? (auth.method === "pi-sdk" ? "Pi SDK" : "ANTHROPIC_API_KEY") : chalk.red("not configured")}`);
    console.log();
  });

program
  .command("ui")
  .description("Open the web UI with chat, citations, and source viewer")
  .argument("<folder>", "Path to your documents folder")
  .option("--port <n>", "Port number", parseInt, 3947)
  .option("--no-open", "Don't auto-open the browser")
  .action(async (folder: string, options: { port: number; open: boolean }) => {
    console.log(`\n${chalk.bold("llm-kb")} web UI\n`);

    const auth = checkAuth();
    if (!auth.ok) exitWithAuthError();

    if (!existsSync(folder)) {
      console.error(chalk.red(`Error: Folder not found: ${folder}`));
      process.exit(1);
    }

    const root = resolve(folder);
    const config = await loadConfig(root);

    // Check KB exists
    if (!existsSync(join(root, ".llm-kb", "wiki", "sources"))) {
      console.error(chalk.red("No knowledge base found. Run 'llm-kb run <folder>' first."));
      process.exit(1);
    }

    const { startWebUI } = await import("./web/server.js");
    await startWebUI({
      folder: root,
      port: options.port,
      open: options.open,
      authStorage: auth.authStorage,
      modelId: config.queryModel,
    });
  });

program.parse();
