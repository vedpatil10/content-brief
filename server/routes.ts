import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage.js";
import { processWorkflow } from "./workflow.js";
import { generateBriefsSchema } from "../shared/schema.js";
import type { ProgressEvent, BriefResult, StructuredBrief } from "../shared/schema.js";
import { randomUUID } from "crypto";
import ExcelJS from "exceljs";

function sanitizeCellText(value: string) {
  return String(value ?? "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\uFFFD/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function createUniqueSheetName(baseName: string, usedNames: Set<string>) {
  const normalizedBase = sanitizeCellText(baseName).replace(/[\\/*?[\]:]/g, "").trim() || "Sheet";
  let candidate = normalizedBase.substring(0, 31);
  let suffix = 1;
  while (usedNames.has(candidate)) {
    const suffixText = `_${suffix}`;
    candidate = `${normalizedBase.substring(0, Math.max(0, 31 - suffixText.length))}${suffixText}`;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function addKeyValueRow(worksheet: ExcelJS.Worksheet, label: string, value: string) {
  const row = worksheet.addRow([sanitizeCellText(label), sanitizeCellText(value)]);
  row.getCell(1).font = { bold: true };
  row.getCell(1).alignment = { vertical: "top" };
  row.getCell(2).alignment = { wrapText: true, vertical: "top" };
}

function addBulletRows(worksheet: ExcelJS.Worksheet, heading: string, items: string[]) {
  const values = items.length ? items.map((item) => `* ${item}`).join("\n") : "* None specified";
  addKeyValueRow(worksheet, heading, values);
}

function populateBriefWorksheet(worksheet: ExcelJS.Worksheet, brief: BriefResult) {
  worksheet.columns = [
    { width: 24 },
    { width: 100 },
    { width: 80 },
    { width: 80 },
  ];

  const structured = brief.structured_brief as StructuredBrief | undefined;

  const titleRow = worksheet.addRow([sanitizeCellText(`Content Brief: ${brief.keyword}`)]);
  titleRow.getCell(1).font = { bold: true, size: 16 };
  worksheet.mergeCells(`A${titleRow.number}:D${titleRow.number}`);

  addKeyValueRow(worksheet, "Keyword", brief.keyword);
  addKeyValueRow(worksheet, "Country", brief.country || "Not specified");
  if (brief.google_doc_url) addKeyValueRow(worksheet, "Google Doc", brief.google_doc_url);
  addKeyValueRow(worksheet, "Generated", brief.timestamp);

  if (structured) {
    worksheet.addRow([]);
    const quickHeader = worksheet.addRow([sanitizeCellText("Quick Notes")]);
    quickHeader.getCell(1).font = { bold: true, size: 14 };
    worksheet.mergeCells(`A${quickHeader.number}:D${quickHeader.number}`);
    addKeyValueRow(worksheet, "H1", structured.h1);
    addKeyValueRow(worksheet, "Search Angle", structured.search_angle);
    addKeyValueRow(worksheet, "Word Count", structured.word_count_range);
    addBulletRows(worksheet, "Title Options", structured.title_options);
    addBulletRows(worksheet, "FAQ Questions", structured.faq_questions);
  }

  worksheet.addRow([]);
  const briefHeader = worksheet.addRow([sanitizeCellText("Copy Ready Brief")]);
  briefHeader.getCell(1).font = { bold: true, size: 14 };
  worksheet.mergeCells(`A${briefHeader.number}:D${briefHeader.number}`);
  for (const line of brief.brief_content.split("\n")) {
    const row = worksheet.addRow([sanitizeCellText(line)]);
    worksheet.mergeCells(`A${row.number}:D${row.number}`);
    row.getCell(1).alignment = { wrapText: true, vertical: "top" };
    if (line.startsWith("CONTENT BRIEF:") || line.startsWith("H1:") || line.startsWith("H2:") || line.startsWith("  H3:")) {
      row.getCell(1).font = { bold: true };
    }
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // New endpoint to just get the keywords from the sheet
  app.post("/api/get-keywords", async (req, res) => {
    const parsed = generateBriefsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    try {
      const { sheetUrl } = parsed.data;
      const { fetchKeywordsFromSheet } = await import("./workflow.js");
      const keywords = await fetchKeywordsFromSheet(sheetUrl);
      res.json({ keywords });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to fetch keywords" });
    }
  });

  // End point to process a single keyword with SSE for progress
  app.post("/api/process-keyword", async (req, res) => {
    const { processKeywordSchema } = await import("../shared/schema.js");
    const parsed = processKeywordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const { keyword, index, total } = parsed.data;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    const safeSend = (data: string) => {
      try {
        if (!res.writableEnded) {
          res.write(data);
        }
      } catch {}
    };

    const sendEvent = (event: ProgressEvent) => {
      safeSend(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      const { processSingleKeyword } = await import("./workflow.js");
      const { keyword, country, rowIndex, sheetUrl, index, total } = req.body;
      const brief = await processSingleKeyword(keyword, country, rowIndex, index, total, sendEvent, sheetUrl);
      safeSend(`data: ${JSON.stringify({ type: "done", brief })}\n\n`);
    } catch (error: any) {
      console.error("Keyword processing error:", error?.message || error);
      const message = error instanceof Error ? error.message : "Unknown error";
      safeSend(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
    } finally {
      try { if (!res.writableEnded) res.end(); } catch {}
    }
  });

  // Legacy route kept for compatibility if needed, but updated to use new single keyword logic
  app.post("/api/generate-briefs", async (req, res) => {
    const parsed = generateBriefsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const { sheetUrl } = parsed.data;
    const jobId = randomUUID();

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    const safeSend = (data: string) => {
      try {
        if (!res.writableEnded) {
          res.write(data);
        }
      } catch {}
    };

    const sendEvent = (event: ProgressEvent) => {
      safeSend(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      const briefs = await processWorkflow(sheetUrl, sendEvent);
      storage.storeJob(jobId, briefs);
      safeSend(`data: ${JSON.stringify({ type: "done", jobId, briefCount: briefs.length })}\n\n`);
    } catch (error: any) {
      console.error("Workflow error:", error?.message || error);
      const message = error instanceof Error ? error.message : "Unknown error";
      safeSend(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
    } finally {
      try { if (!res.writableEnded) res.end(); } catch {}
    }
  });

  // New endpoint to generate Excel from client-provided briefs
  app.post("/api/generate-excel", async (req, res) => {
    const { generateExcelSchema } = await import("../shared/schema.js");
    const parsed = generateExcelSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const { briefs } = parsed.data;
    if (!briefs || briefs.length === 0) {
      return res.status(400).json({ error: "No briefs provided" });
    }

    try {
      const workbook = new ExcelJS.Workbook();
      const usedSheetNames = new Set<string>();

      for (const brief of briefs) {
        const sheetName = createUniqueSheetName(brief.keyword, usedSheetNames);
        const worksheet = workbook.addWorksheet(sheetName);
        populateBriefWorksheet(worksheet, brief);
      }

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", 'attachment; filename="content_briefs.xlsx"');

      await workbook.xlsx.write(res);
      res.end();
    } catch (error) {
      console.error("Excel generation error:", error);
      res.status(500).json({ error: "Failed to generate Excel file" });
    }
  });

  app.get("/api/download/:jobId", async (req, res) => {
    const { jobId } = req.params;
    const briefs = storage.getJob(jobId);

    if (!briefs || briefs.length === 0) {
      return res.status(404).json({ error: "Job not found or no briefs generated" });
    }

    try {
      const workbook = new ExcelJS.Workbook();
      const usedSheetNames = new Set<string>();

      for (const brief of briefs) {
        const sheetName = createUniqueSheetName(brief.keyword, usedSheetNames);
        const worksheet = workbook.addWorksheet(sheetName);
        populateBriefWorksheet(worksheet, brief);
      }

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", 'attachment; filename="content_briefs.xlsx"');

      await workbook.xlsx.write(res);
      res.end();

      storage.deleteJob(jobId);
    } catch (error) {
      console.error("Excel generation error:", error);
      res.status(500).json({ error: "Failed to generate Excel file" });
    }
  });

  return httpServer;
}

