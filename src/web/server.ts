import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { exec } from "node:child_process";
import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import { createOllamaDirectSession } from "./ollama-direct.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface WebUIOptions {
  folder: string;
  port: number;
  open: boolean;
  authStorage?: AuthStorage;
  modelId?: string;
}

// ── Server ──────────────────────────────────────────────────────────────────

export async function startWebUI(options: WebUIOptions): Promise<void> {
  const { folder, port, open } = options;
  const kbDir = join(folder, ".llm-kb");
  const sourcesDir = join(kbDir, "wiki", "sources");

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // ── Static files ──────────────────────────────────────────────────────
  // Serve index.html at /
  // Resolve paths relative to the CLI entry point (bin/cli.js)
  const cliDir = dirname(fileURLToPath(import.meta.url));

  app.get("/", async (c) => {
    // Try multiple locations to find index.html
    const candidates = [
      join(cliDir, "public", "index.html"),                    // bin/public/index.html
      join(cliDir, "..", "bin", "public", "index.html"),       // from project root
      join(cliDir, "..", "src", "web", "public", "index.html"), // dev source
      join(process.cwd(), "bin", "public", "index.html"),       // cwd fallback
      join(process.cwd(), "src", "web", "public", "index.html"),// cwd dev fallback
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        const html = await readFile(p, "utf-8");
        return c.html(html);
      }
    }
    return c.text(`index.html not found. Searched: ${candidates.join(", ")}`, 404);
  });

  // ── API: Status ───────────────────────────────────────────────────────

  app.get("/api/status", async (c) => {
    let sourceCount = 0;
    let wikiExists = false;
    let wikiConcepts = 0;

    try {
      const files = await readdir(sourcesDir);
      sourceCount = files.filter((f) => f.endsWith(".md")).length;
    } catch {}

    const wikiPath = join(kbDir, "wiki", "wiki.md");
    if (existsSync(wikiPath)) {
      wikiExists = true;
      try {
        const wiki = await readFile(wikiPath, "utf-8");
        wikiConcepts = (wiki.match(/^## /gm) || []).length;
      } catch {}
    }

    // Include model/provider info for UI badge
    const modelId = options.modelId || "llama3.2";
    const isOllama = !process.env.ANTHROPIC_API_KEY;
    const provider = isOllama ? "ollama" : "anthropic";

    return c.json({ sourceCount, wikiExists, wikiConcepts, folder, modelId, provider });
  });

  // ── API: Sources ──────────────────────────────────────────────────────

  app.get("/api/sources", async (c) => {
    try {
      const files = await readdir(sourcesDir);
      const sources = [];
      for (const f of files.filter((f) => f.endsWith(".json"))) {
        try {
          const data = JSON.parse(await readFile(join(sourcesDir, f), "utf-8"));
          sources.push({
            name: data.source || f.replace(".json", ".pdf"),
            pages: data.totalPages || 0,
            jsonFile: f,
            mdFile: f.replace(".json", ".md"),
          });
        } catch {}
      }
      return c.json(sources);
    } catch {
      return c.json([]);
    }
  });

  // ── API: Sessions ─────────────────────────────────────────────────────

  app.get("/api/sessions", async (c) => {
    const sessionsDir = join(kbDir, "sessions");
    const tracesDir = join(kbDir, "traces");
    try {
      // Read traces (they have structured data)
      const traceFiles = existsSync(tracesDir)
        ? (await readdir(tracesDir)).filter((f) => f.endsWith(".json"))
        : [];

      const sessions = [];
      for (const f of traceFiles) {
        try {
          const trace = JSON.parse(await readFile(join(tracesDir, f), "utf-8"));
          if (trace.mode === "query" && trace.question) {
            sessions.push({
              id: trace.sessionId,
              question: trace.question,
              timestamp: trace.timestamp,
              model: trace.model,
              citationCount: trace.citations?.length ?? 0,
              filesRead: trace.filesRead?.length ?? 0,
            });
          }
        } catch {}
      }

      // Sort newest first
      sessions.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      return c.json(sessions);
    } catch {
      return c.json([]);
    }
  });

  app.get("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const tracesDir = join(kbDir, "traces");
    const tracePath = join(tracesDir, `${id}.json`);

    if (!existsSync(tracePath)) return c.json({ error: "Not found" }, 404);

    try {
      const trace = JSON.parse(await readFile(tracePath, "utf-8"));
      return c.json(trace);
    } catch {
      return c.json({ error: "Failed to read trace" }, 500);
    }
  });

  // ── API: PDF files ────────────────────────────────────────────────────

  app.get("/api/pdf/:filename", async (c) => {
    const filename = decodeURIComponent(c.req.param("filename"));
    // Search for the PDF in the user's folder
    const pdfPath = join(folder, filename);
    if (existsSync(pdfPath)) {
      const buf = await readFile(pdfPath);
      return c.body(buf, { headers: { "Content-Type": "application/pdf" } });
    }
    // Try without number prefix
    try {
      const files = await readdir(folder);
      const match = files.find((f) => f.endsWith(".pdf") && f.includes(filename.replace(/^\d+\.\s*/, "")));
      if (match) {
        const buf = await readFile(join(folder, match));
        return c.body(buf, { headers: { "Content-Type": "application/pdf" } });
      }
    } catch {}
    return c.text("PDF not found", 404);
  });

  // ── API: Bbox JSON ────────────────────────────────────────────────────

  app.get("/api/bbox/:filename", async (c) => {
    const filename = decodeURIComponent(c.req.param("filename"));
    // Map PDF name to JSON
    const jsonName = filename.replace(/\.pdf$/i, ".json");
    const jsonPath = join(sourcesDir, jsonName);

    if (existsSync(jsonPath)) {
      const data = await readFile(jsonPath, "utf-8");
      return c.json(JSON.parse(data));
    }
    // Fuzzy find
    try {
      const files = await readdir(sourcesDir);
      const needle = filename.replace(/\.pdf$/i, "").replace(/^\d+\.\s*/, "").toLowerCase();
      const match = files.find((f) => f.endsWith(".json") && f.toLowerCase().includes(needle));
      if (match) {
        const data = await readFile(join(sourcesDir, match), "utf-8");
        return c.json(JSON.parse(data));
      }
    } catch {}
    return c.json({ error: "Bbox data not found" }, 404);
  });

  // ── API: Wiki ─────────────────────────────────────────────────────────

  app.get("/api/wiki", async (c) => {
    const wikiPath = join(kbDir, "wiki", "wiki.md");
    if (!existsSync(wikiPath)) return c.json({ content: "" });
    try {
      const content = await readFile(wikiPath, "utf-8");
      return c.json({ content });
    } catch {
      return c.json({ content: "" });
    }
  });

  app.put("/api/wiki", async (c) => {
    const wikiPath = join(kbDir, "wiki", "wiki.md");
    try {
      const body = await c.req.json();
      if (typeof body.content !== "string") {
        return c.json({ error: "Missing content field" }, 400);
      }
      const { mkdir: mkdirFs } = await import("node:fs/promises");
      await mkdirFs(join(kbDir, "wiki"), { recursive: true });
      await writeFile(wikiPath, body.content, "utf-8");
      return c.json({ ok: true });
    } catch (err: any) {
      console.error("[api] Failed to save wiki:", err.message);
      return c.json({ error: "Failed to save wiki" }, 500);
    }
  });

  // ── WebSocket: Chat ───────────────────────────────────────────────────

  app.get("/ws/chat", upgradeWebSocket((c) => {
    let chatSession: Awaited<ReturnType<typeof createOllamaDirectSession>> | null = null;
    let creating = false;
    let wsRef: any = null;

    return {
      onOpen(evt, ws) {
        wsRef = ws;
        console.log("[ws] Client connected");
        ws.send(JSON.stringify({ type: "connected", message: "llm-kb web UI ready" }));

        // Create direct Ollama session in background
        creating = true;
        createOllamaDirectSession(folder, {
          send(data: string) {
            try { wsRef?.send(data); } catch (e) { console.error("[ws] send error:", e); }
          },
        }, {
          modelId: options.modelId,
        }).then((session) => {
          chatSession = session;
          creating = false;
          console.log("[ws] Ollama direct session ready");
          try { wsRef?.send(JSON.stringify({ type: "ready" })); } catch {}
        }).catch((err: any) => {
          creating = false;
          console.error("[ws] Session creation failed:", err.message);
          try { wsRef?.send(JSON.stringify({ type: "error", message: err.message })); } catch {}
        });
      },
      onMessage(evt, ws) {
        const raw = typeof evt.data === "string" ? evt.data : "";
        let data: any;
        try { data = JSON.parse(raw); } catch { return; }

        console.log("[ws] Received:", data.type, data.text?.slice(0, 50));

        if (data.type === "message" && data.text) {
          if (!chatSession) {
            const msg = creating ? "Session still initializing, please wait..." : "Session not ready";
            ws.send(JSON.stringify({ type: "error", message: msg }));
            return;
          }
          chatSession.prompt(data.text).catch((err: any) => {
            console.error("[ws] Prompt error:", err.message);
            try { ws.send(JSON.stringify({ type: "error", message: err.message })); } catch {}
          });
        }
      },
      onClose() {
        console.log("[ws] Client disconnected");
        if (chatSession) {
          chatSession.dispose();
          chatSession = null;
        }
        wsRef = null;
      },
    };
  }));

  // ── Start ─────────────────────────────────────────────────────────────

  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`\n  🌐 llm-kb web UI running at http://localhost:${port}\n`);
  });

  server.on("error", (err: any) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\n  ❌ Port ${port} is already in use. Either:\n     - Close the other llm-kb instance\n     - Use a different port: llm-kb ui <folder> --port 3948\n`);
      process.exit(1);
    }
    throw err;
  });

  injectWebSocket(server);

  // Auto-open browser
  if (open) {
    const url = `http://localhost:${port}`;
    const cmd = process.platform === "win32" ? `start "" "${url}"`
      : process.platform === "darwin" ? `open "${url}"`
      : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }

  // Keep process alive
  await new Promise(() => {});
}
