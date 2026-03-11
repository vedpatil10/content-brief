import express, { type Express } from "express";
import fs from "fs";
import path from "path";
import { log } from "./index.js";


export function serveStatic(app: Express) {
  if (process.env.VERCEL) {
    // Vercel handles static file serving via the Output Directory setting
    return;
  }

  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    log(`Warning: Could not find build directory: ${distPath}. Skipping static serving.`);
    return;
  }

  app.use(express.static(distPath));

  app.use("/{*path}", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}

