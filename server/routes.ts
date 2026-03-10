import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { processWorkflow } from "./workflow";
import { generateBriefsSchema } from "@shared/schema";
import type { ProgressEvent, BriefResult } from "@shared/schema";
import { randomUUID } from "crypto";
import ExcelJS from "exceljs";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

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

        worksheet.getColumn(1).width = 120;

        const lines = brief.brief_content.split("\n");
        for (const line of lines) {
          const row = worksheet.addRow([line]);
          const cell = row.getCell(1);
          cell.alignment = { wrapText: true, vertical: "top" };

          if (line.startsWith("===") || line.startsWith("CONTENT BRIEF:")) {
            cell.font = { bold: true, size: 14 };
          } else if (line.startsWith("H1:") || line.startsWith("H2:")) {
            cell.font = { bold: true, size: 12 };
          } else if (line.startsWith("H3:")) {
            cell.font = { bold: true, size: 11 };
          }
        }
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
