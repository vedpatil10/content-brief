import { z } from "zod";

export const generateBriefsSchema = z.object({
  sheetUrl: z.string().url().refine(
    (url) => url.includes("docs.google.com/spreadsheets"),
    "Must be a Google Sheets URL"
  ),
});

export type GenerateBriefsInput = z.infer<typeof generateBriefsSchema>;

export interface BriefResult {
  keyword: string;
  brief_content: string;
  timestamp: string;
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
