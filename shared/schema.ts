import { z } from "zod";

export const generateBriefsSchema = z.object({
  sheetUrl: z.string().url().refine(
    (url) => url.includes("docs.google.com/spreadsheets"),
    "Must be a Google Sheets URL"
  ),
});

export const processKeywordSchema = z.object({
  keyword: z.string(),
  country: z.string().optional(),
  index: z.number(),
  total: z.number(),
});

export const generateExcelSchema = z.object({
  briefs: z.array(z.object({
    keyword: z.string(),
    country: z.string().optional(),
    brief_content: z.string(),
    timestamp: z.string(),
    google_doc_url: z.string().optional(),
  })),
});

export type GenerateBriefsInput = z.infer<typeof generateBriefsSchema>;

export interface BriefResult {
  keyword: string;
  country?: string;
  brief_content: string;
  timestamp: string;
  google_doc_url?: string;
}

export interface ProgressEvent {
  type: "started" | "searching" | "filtering" | "scraping" | "summarizing" | "generating" | "complete" | "error" | "keyword_start" | "keyword_complete";
  keyword?: string;
  message: string;
  current?: number;
  total?: number;
}

export const users = {} as any;
export type InsertUser = any;
export type User = any;
