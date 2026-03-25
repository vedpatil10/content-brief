import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage.js";
import { processWorkflow } from "./workflow.js";
import { generateBriefsSchema } from "../shared/schema.js";
import type { ProgressEvent, BriefResult, StructuredBrief } from "../shared/schema.js";
import { randomUUID } from "crypto";
import ExcelJS from "exceljs";

function addKeyValueRow(worksheet: ExcelJS.Worksheet, label: string, value: string) {
  const row = worksheet.addRow([label, value]);
  row.getCell(1).font = { bold: true };
  row.getCell(1).alignment = { vertical: "top" };
  row.getCell(2).alignment = { wrapText: true, vertical: "top" };
}

function addBulletRows(worksheet: ExcelJS.Worksheet, heading: string, items: string[]) {
  const values = items.length ? items.map((item) => `• ${item}`).join("\n") : "• None specified";
  addKeyValueRow(worksheet, heading, values);
}

function populateBriefWorksheet(worksheet: ExcelJS.Worksheet, brief: BriefResult) {
  worksheet.columns = [
    { width: 24 },
    { width: 80 },
    { width: 80 },
    { width: 80 },
    { width: 80 },
    { width: 80 },
    { width: 80 },
    { width: 80 },
  ];

  const structured = brief.structured_brief as StructuredBrief | undefined;

  const titleRow = worksheet.addRow([`Content Brief: ${brief.keyword}`]);
  titleRow.getCell(1).font = { bold: true, size: 16 };
  worksheet.mergeCells(`A${titleRow.number}:H${titleRow.number}`);

  worksheet.addRow([]);
  const readableHeader = worksheet.addRow(["Readable Brief"]);
  readableHeader.getCell(1).font = { bold: true, size: 14 };
  worksheet.mergeCells(`A${readableHeader.number}:H${readableHeader.number}`);
  for (const line of brief.brief_content.split("\n")) {
    const row = worksheet.addRow([line]);
    worksheet.mergeCells(`A${row.number}:H${row.number}`);
    row.getCell(1).alignment = { wrapText: true, vertical: "top" };
    if (line.startsWith("CONTENT BRIEF:") || line.startsWith("H1:") || line.startsWith("H2:") || line.startsWith("  H3:")) {
      row.getCell(1).font = { bold: true };
    }
  }

  addKeyValueRow(worksheet, "Keyword", brief.keyword);
  addKeyValueRow(worksheet, "Country", brief.country || "Not specified");
  if (brief.google_doc_url) addKeyValueRow(worksheet, "Google Doc", brief.google_doc_url);
  addKeyValueRow(worksheet, "Generated", brief.timestamp);

  if (!structured) {
    worksheet.addRow([]);
    const contentHeader = worksheet.addRow(["Brief Content"]);
    contentHeader.getCell(1).font = { bold: true, size: 14 };
    worksheet.mergeCells(`A${contentHeader.number}:H${contentHeader.number}`);
    for (const line of brief.brief_content.split("\n")) {
      const row = worksheet.addRow([line]);
      worksheet.mergeCells(`A${row.number}:H${row.number}`);
      row.getCell(1).alignment = { wrapText: true, vertical: "top" };
    }
    return;
  }

  worksheet.addRow([]);
  const snapshotHeader = worksheet.addRow(["Brief Snapshot"]);
  snapshotHeader.getCell(1).font = { bold: true, size: 14 };
  worksheet.mergeCells(`A${snapshotHeader.number}:H${snapshotHeader.number}`);

  addKeyValueRow(worksheet, "Search Intent", structured.search_intent);
  addKeyValueRow(worksheet, "Search Angle", structured.search_angle);
  addKeyValueRow(worksheet, "Article Type", structured.article_type);
  addKeyValueRow(worksheet, "Summary", structured.brief_summary);
  addKeyValueRow(worksheet, "H1", structured.h1);
  addKeyValueRow(worksheet, "Word Count", structured.word_count_range);
  addKeyValueRow(worksheet, "Page Goal", structured.page_goal);
  addKeyValueRow(worksheet, "Persona", structured.target_persona);
  addKeyValueRow(worksheet, "Page Format", structured.page_format);
  addKeyValueRow(worksheet, "URL Slug", structured.url_slug);
  addBulletRows(worksheet, "Title Options", structured.title_options);
  addBulletRows(worksheet, "Item Template", structured.item_template);
  addBulletRows(worksheet, "Comparison Points", structured.comparison_points);
  addBulletRows(worksheet, "FAQ Questions", structured.faq_questions);
  addBulletRows(worksheet, "Secondary Keywords", structured.secondary_keywords);
  addBulletRows(worksheet, "Long-tail Keywords", structured.long_tail_keywords);
  addBulletRows(worksheet, "Entities", structured.entities);
  addBulletRows(worksheet, "Semantic Terms", structured.semantic_terms);
  addBulletRows(worksheet, "Internal Links", structured.internal_links);
  addBulletRows(worksheet, "External Linking Strategy", structured.external_linking_strategy);
  addBulletRows(worksheet, "Media Ideas", structured.media_ideas);
  addBulletRows(worksheet, "Content Gaps", structured.content_gaps);
  addBulletRows(worksheet, "Meta Descriptions", structured.meta_descriptions);

  worksheet.addRow([]);
  const outlineHeader = worksheet.addRow([
    "Level",
    "Heading",
    "Purpose",
    "Section Type",
    "Must Cover",
    "Research Needed",
    "Differentiation",
    "Examples / Watch Outs",
  ]);
  outlineHeader.eachCell((cell) => {
    cell.font = { bold: true };
    cell.alignment = { wrapText: true, vertical: "top" };
  });

  for (const section of structured.sections) {
    const row = worksheet.addRow([
      section.level,
      section.heading,
      section.purpose,
      section.section_type,
      section.must_cover.join("\n"),
      section.research_needed.join("\n"),
      section.differentiation.join("\n"),
      [...section.examples, ...section.watch_out_for.map((item) => `Watch out: ${item}`)].join("\n"),
    ]);
    row.eachCell((cell) => {
      cell.alignment = { wrapText: true, vertical: "top" };
    });

    for (const subsection of section.subsections) {
      const subRow = worksheet.addRow([
        "H3",
        subsection.heading,
        subsection.purpose,
        "subsection",
        subsection.must_cover.join("\n"),
        "",
        "",
        "",
      ]);
      subRow.eachCell((cell) => {
        cell.alignment = { wrapText: true, vertical: "top" };
      });
    }
  }

  worksheet.addRow([]);
  const competitorHeader = worksheet.addRow(["Competitor References"]);
  competitorHeader.getCell(1).font = { bold: true, size: 14 };
  worksheet.mergeCells(`A${competitorHeader.number}:H${competitorHeader.number}`);
  const competitorTableHeader = worksheet.addRow(["Title", "URL", "Why It Matters"]);
  competitorTableHeader.eachCell((cell) => {
    cell.font = { bold: true };
  });
  for (const reference of structured.competitor_references) {
    const row = worksheet.addRow([reference.title, reference.url, reference.why_it_matters]);
    row.eachCell((cell) => {
      cell.alignment = { wrapText: true, vertical: "top" };
    });
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

      for (const brief of briefs) {
        const sheetName = brief.keyword.substring(0, 31).replace(/[\\/*?[\]:]/g, "");
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

      for (const brief of briefs) {
        const sheetName = brief.keyword.substring(0, 31).replace(/[\\/*?[\]:]/g, "");
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
