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
    structured_brief: z.any().optional(),
  })),
});

export type GenerateBriefsInput = z.infer<typeof generateBriefsSchema>;

export interface BriefSubsection {
  heading: string;
  purpose: string;
  must_cover: string[];
}

export interface BriefSection {
  level: "H2" | "H3";
  heading: string;
  purpose: string;
  section_type: string;
  must_cover: string[];
  research_needed: string[];
  differentiation: string[];
  examples: string[];
  watch_out_for: string[];
  subsections: BriefSubsection[];
}

export interface StructuredBrief {
  search_intent: string;
  search_angle: string;
  article_type: string;
  brief_summary: string;
  title_options: string[];
  h1: string;
  sections: BriefSection[];
  item_template: string[];
  comparison_points: string[];
  faq_questions: string[];
  word_count_range: string;
  page_goal: string;
  target_persona: string;
  page_format: string;
  meta_descriptions: string[];
  url_slug: string;
  secondary_keywords: string[];
  long_tail_keywords: string[];
  entities: string[];
  semantic_terms: string[];
  internal_links: string[];
  external_linking_strategy: string[];
  media_ideas: string[];
  content_gaps: string[];
  competitor_references: Array<{
    title: string;
    url: string;
    why_it_matters: string;
  }>;
}

export interface BriefResult {
  keyword: string;
  country?: string;
  brief_content: string;
  timestamp: string;
  google_doc_url?: string;
  structured_brief?: StructuredBrief;
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
