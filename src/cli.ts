#!/usr/bin/env node

import { Command } from "commander";
import { scan, summarize } from "./scan.js";
import { parsePDF } from "./pdf.js";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import chalk from "chalk";

const program = new Command();

program
  .name("llm-kb")
  .description("Drop files into a folder. Get a knowledge base you can query.")
  .version("0.0.1");

program
  .command("run")
  .description("Scan, parse, index, and watch a folder")
  .argument("<folder>", "Path to your documents folder")
  .action(async (folder: string) => {
    console.log(`\n${chalk.bold("llm-kb")} v0.0.1\n`);

    if (!existsSync(folder)) {
      console.error(chalk.red(`Error: Folder not found: ${folder}`));
      process.exit(1);
    }

    console.log(`Scanning ${folder}...`);

    const files = await scan(folder);

    if (files.length === 0) {
      console.log(chalk.yellow("  No supported files found."));
      return;
    }

    const pdfs = files.filter((f) => f.ext === ".pdf");
    console.log(`  Found ${chalk.bold(files.length.toString())} files (${summarize(files)})`);
    if (pdfs.length === 0) return;

    // Set up .llm-kb folder structure
    const root = resolve(folder);
    const sourcesDir = join(root, ".llm-kb", "wiki", "sources");
    await mkdir(sourcesDir, { recursive: true });

    // Parse PDFs with inline progress
    let parsed = 0;
    let skipped = 0;
    let failed = 0;
    const errors: { name: string; message: string }[] = [];

    for (let i = 0; i < pdfs.length; i++) {
      const pdf = pdfs[i];
      const fullPath = join(root, pdf.path);

      // Inline progress — overwrite same line
      const progress = `  Parsing... ${i + 1}/${pdfs.length} — ${pdf.name}`;
      process.stdout.write(`\r${progress.padEnd(80)}`);

      try {
        const result = await parsePDF(fullPath, sourcesDir);
        if (result.skipped) {
          skipped++;
        } else {
          parsed++;
        }
      } catch (err: any) {
        failed++;
        errors.push({ name: pdf.name, message: err.message });
      }
    }

    // Clear progress line
    process.stdout.write(`\r${"".padEnd(80)}\r`);

    // Summary
    const parts: string[] = [];
    if (parsed > 0) parts.push(chalk.green(`${parsed} parsed`));
    if (skipped > 0) parts.push(chalk.dim(`${skipped} skipped (up to date)`));
    if (failed > 0) parts.push(chalk.red(`${failed} failed`));
    console.log(`  ${parts.join(", ")}`);

    // Show errors
    for (const err of errors) {
      console.log(chalk.red(`    ✗ ${err.name} — ${err.message}`));
    }

    console.log(`\n  ${chalk.dim("Output:")} ${sourcesDir}`);
  });

program.parse();
