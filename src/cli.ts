#!/usr/bin/env node

import { Command } from "commander";
import { scan, summarize } from "./scan.js";
import { parsePDF } from "./pdf.js";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";

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
    console.log(`\nllm-kb v0.0.1\n`);

    if (!existsSync(folder)) {
      console.error(`Error: Folder not found: ${folder}`);
      process.exit(1);
    }

    console.log(`Scanning ${folder}...`);

    const files = await scan(folder);

    if (files.length === 0) {
      console.log("  No supported files found.");
      return;
    }

    console.log(`  Found ${files.length} files (${summarize(files)})`);

    // Set up .llm-kb folder structure
    const root = resolve(folder);
    const sourcesDir = join(root, ".llm-kb", "wiki", "sources");
    await mkdir(sourcesDir, { recursive: true });

    // Parse PDFs
    const pdfs = files.filter((f) => f.ext === ".pdf");
    if (pdfs.length > 0) {
      console.log(`\n  Parsing ${pdfs.length} PDFs...`);
    }

    for (const pdf of pdfs) {
      const fullPath = join(root, pdf.path);
      try {
        const result = await parsePDF(fullPath, sourcesDir);
        console.log(
          `    ✓ ${pdf.name} → ${result.totalPages} pages, ${(result.textLength / 1024).toFixed(1)}KB`
        );
      } catch (err: any) {
        console.error(`    ✗ ${pdf.name} — ${err.message}`);
      }
    }

    console.log(`\n  Output: ${sourcesDir}`);
  });

program.parse();
