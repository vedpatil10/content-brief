import OpenAI from "openai";
import type { BriefResult, ProgressEvent, StructuredBrief } from "../shared/schema.js";
import pLimit from "p-limit";
import { google } from "googleapis";
import { JWT } from "google-auth-library";

import { log } from "./index.js";


// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

const getModelName = () => process.env.OPENAI_MODEL || "gpt-4o-mini";

const SERPER_API_KEY = () => process.env.SERPER_API_KEY || "";
const KEYWORD_COOLDOWN_MS = Number(process.env.KEYWORD_COOLDOWN_MS || 2500);
const LOAD_BACKOFF_MS = Number(process.env.LOAD_BACKOFF_MS || 8000);
const MAX_COMPETITOR_URLS = Math.max(1, Number(process.env.MAX_COMPETITOR_URLS || 3));
const FAST_MODE = (process.env.BRIEF_FAST_MODE || "true").toLowerCase() !== "false";
const ENABLE_GOOGLE_DOC = (process.env.ENABLE_GOOGLE_DOC || "false").toLowerCase() === "true";
const CONTENT_OUTPUT_MODE = (process.env.CONTENT_OUTPUT_MODE || "article").toLowerCase();


type SendEvent = (event: ProgressEvent) => void;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 5, waitMs = 5000): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      if (attempt === maxRetries) throw error;

      const errorMessage = error instanceof Error ? error.message : String(error);
      let backoff = waitMs;

      // Smart Retry: Detect OpenAI Rate Limit errors
      if (errorMessage.includes("429") || errorMessage.includes("rate_limit")) {
        log(`Rate limit hit on attempt ${attempt}. Waiting 30s...`, "workflow");
        backoff = 30000;
      } else {
        log(`Retry ${attempt}/${maxRetries} after error: ${errorMessage}`, "workflow");
      }

      await delay(backoff);
    }
  }
  throw new Error(`Exhausted retries after ${maxRetries} attempts`);
}

function extractSheetId(url: string): string {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) throw new Error("Invalid Google Sheets URL");
  return match[1];
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

// Helper for Google Auth
async function getGoogleAuth() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!clientEmail || !privateKey) {
    throw new Error("Missing Google credentials in Environment Variables (GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY)");
  }

  const auth = new JWT({
    email: clientEmail,
    key: privateKey,
    scopes: [
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive",
    ],
  });

  return auth;
}

async function createGoogleDoc(keyword: string, content: string): Promise<string> {
  const auth = await getGoogleAuth();
  const docs = google.docs({ version: "v1", auth });
  const drive = google.drive({ version: "v3", auth });

  log(`Creating Google Doc for keyword: ${keyword}`, "workflow");

  // 1. Create a new document
  const doc = await docs.documents.create({
    requestBody: {
      title: `Content Brief: ${keyword}`,
    },
  });

  const documentId = doc.data.documentId;
  if (!documentId) throw new Error("Failed to create Google Doc");

  // 2. Add content to the document
  await docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: [
        {
          insertText: {
            location: { index: 1 },
            text: content,
          },
        },
      ],
    },
  });

  // 3. Make document readable by anyone with the link
  await drive.permissions.create({
    fileId: documentId,
    requestBody: {
      role: "reader",
      type: "anyone",
    },
  });

  return `https://docs.google.com/documents/d/${documentId}/edit`;
}

async function writeBackToSheet(sheetUrl: string, rowIndex: number, docUrl: string): Promise<void> {
  try {
    const auth = await getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const sheetId = extractSheetId(sheetUrl);

    log(`Writing Doc URL to Sheet at row ${rowIndex}`, "workflow");

    // We'll try to append to Column C (column index 3)
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `Sheet1!C${rowIndex}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[docUrl]],
      },
    });
  } catch (error) {
    log(`Warning: Write back to sheet failed: ${error}`, "workflow");
  }
}

export async function fetchKeywordsFromSheet(sheetUrl: string): Promise<Array<{ keyword: string; country?: string; rowIndex: number }>> {
  const sheetId = extractSheetId(sheetUrl);
  const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=0`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  let response: Response;
  try {
    response = await fetch(csvUrl, {
      signal: controller.signal,
      redirect: "follow",
    });
  } catch (err) {
    clearTimeout(timeout);
    throw new Error("Failed to fetch Google Sheet. Request timed out or the sheet is not accessible.");
  }
  clearTimeout(timeout);

  if (!response.ok) {
    throw new Error(`Failed to fetch Google Sheet. Make sure the sheet is shared publicly (Anyone with the link can view).`);
  }

  const csvText = await response.text();

  if (csvText.trim().startsWith("<!DOCTYPE") || csvText.trim().startsWith("<html")) {
    throw new Error("Failed to fetch Google Sheet. Make sure the sheet is shared publicly (Anyone with the link can view).");
  }
  const lines = csvText.trim().split("\n");

  if (lines.length < 2) {
    throw new Error("Sheet appears empty or has no data rows");
  }

  const headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase().replace(/^["']|["']$/g, ""));
  const keywordIndex = headers.indexOf("keyword");
  const countryIndex = headers.findIndex(h => h.includes("country") || h.includes("location") || h.includes("region"));

  if (keywordIndex === -1) {
    throw new Error('Sheet must have a column named "keyword"');
  }

  if (countryIndex === -1) {
    throw new Error('Sheet must have a column named "country" (or "location"/"region")');
  }

  const items = lines.slice(1)
    .map((line, index) => {
      const cols = parseCSVLine(line);
      const keyword = (cols[keywordIndex] || "").replace(/^["']|["']$/g, "").trim();
      const country = countryIndex !== -1 ? (cols[countryIndex] || "").replace(/^["']|["']$/g, "").trim() : undefined;
      return { keyword, country, rowIndex: index + 2 };
    })
    .filter((item) => item.keyword.length > 0);

  if (items.length === 0) {
    throw new Error("No keywords found in the sheet");
  }

  return items;
}

const EXCLUDED_DOMAINS = [
  "reddit.com", "facebook.com", "instagram.com",
  "twitter.com", "x.com", "tiktok.com", "pinterest.com",
  "youtube.com", "linkedin.com",
];

function shouldExclude(url: string): boolean {
  const lowerUrl = url.toLowerCase();
  return EXCLUDED_DOMAINS.some((domain) => lowerUrl.includes(domain));
}

interface SearchResult {
  title: string;
  link: string;
  snippet: string;
  position: number;
}

interface KeywordSignals {
  keywordType: string;
  inferredIntent: string;
  articleFormat: string;
  listCount?: number;
  primarySubject: string;
  modifierTerms: string[];
  localeHints: string[];
  requiresLocalSpecifics: boolean;
  dataPoints: string[];
  sectionPatterns: string[];
  mandatorySections: string[];
  itemDetailRequirements: string[];
}

interface BriefBlueprint {
  inferredIntent: string;
  articleFormat: string;
  searchAngle: string;
  localeFocus: string;
  suggestedTitleAngles: string[];
  recommendedH2s: Array<{
    heading: string;
    purpose: string;
    keyPoints: string[];
    examples: string[];
    watchOutFor: string[];
    h3s: string[];
  }>;
  requiredDataPoints: string[];
  sectionsToAvoid: string[];
  secondaryKeywords: string[];
  longTailKeywords: string[];
  semanticTerms: string[];
  entities: string[];
  faqQuestions: string[];
  opportunities: string[];
  pageGoal: string;
  persona: string;
  wordCountRange: string;
  pageFormat: string;
  metaDescriptionAngles: string[];
}

interface DraftBriefSection {
  level: "H2" | "H3";
  heading: string;
  purpose: string;
  section_type: string;
  must_cover: string[];
  research_needed: string[];
  differentiation: string[];
  examples: string[];
  watch_out_for: string[];
  subsections: Array<{
    heading: string;
    purpose: string;
    must_cover: string[];
  }>;
}

interface IntentProfile {
  keywordType: string;
  inferredIntent: string;
  articleFormat: string;
  primarySubject: string;
  audience: string;
  freshnessExpectation: string;
  needsEntityLevelCoverage: boolean;
  needsItemByItemCoverage: boolean;
  targetItemCount: number;
  mandatoryCoverage: string[];
  preferredSectionPatterns: string[];
  avoidedPatterns: string[];
  qualityTargets: string[];
}

interface CompetitorInsight {
  source_url: string;
  page_title: string;
  content_format: string;
  estimated_word_count: number;
  headings: string[];
  common_themes: string[];
  unique_angles: string[];
  notable_features: string[];
  named_entities: string[];
  factual_attributes: string[];
  locale_signals: string[];
  item_candidates: string[];
  faq_candidates: string[];
  pricing_mentions: string[];
  comparison_dimensions: string[];
}

interface AggregatedSerpInsights {
  topHeadings: string[];
  recurringThemes: string[];
  recurringEntities: string[];
  recurringAttributes: string[];
  recurringFaqs: string[];
  itemCandidates: string[];
  pricingSignals: string[];
  comparisonDimensions: string[];
  localeSignals: string[];
  contentFormats: string[];
  opportunities: string[];
  examplesByUrl: Array<{
    url: string;
    title: string;
    winning_angles: string[];
    entities: string[];
    attributes: string[];
  }>;
}

interface EntityEnrichment {
  entityType: string;
  profiles: Array<{
    name: string;
    whyItMatters: string;
    mustCover: string[];
  }>;
}

interface OutlinePlan {
  h1: string;
  titleAngles: string[];
  sections: DraftBriefSection[];
  comparisonPoints: string[];
  faqQuestions: string[];
  itemTemplate: string[];
  opportunities: string[];
}

interface BriefQualityReport {
  score: number;
  issues: string[];
  strengths: string[];
  needsRepair: boolean;
}

function safeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function dedupeStrings(items: Array<string | undefined | null>, limit = 50): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const normalized = String(item || "").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function safeNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compactJson<T>(value: T): string {
  return JSON.stringify(value, null, 2);
}

function normalizeDraftSubsection(subsection: any): { heading: string; purpose: string; must_cover: string[] } | null {
  const heading = String(subsection?.heading || "").trim();
  if (!heading) return null;
  return {
    heading,
    purpose: String(subsection?.purpose || "").trim(),
    must_cover: safeStringArray(subsection?.must_cover),
  };
}

function normalizeDraftSection(section: any): DraftBriefSection | null {
  const heading = String(section?.heading || "").trim();
  if (!heading) return null;

  return {
    level: section?.level === "H3" ? "H3" : "H2",
    heading,
    purpose: String(section?.purpose || "").trim(),
    section_type: String(section?.section_type || "core").trim(),
    must_cover: safeStringArray(section?.must_cover),
    research_needed: safeStringArray(section?.research_needed),
    differentiation: safeStringArray(section?.differentiation),
    examples: safeStringArray(section?.examples),
    watch_out_for: safeStringArray(section?.watch_out_for),
    subsections: Array.isArray(section?.subsections)
      ? section.subsections
          .map(normalizeDraftSubsection)
          .filter((subsection): subsection is { heading: string; purpose: string; must_cover: string[] } => Boolean(subsection))
      : [],
  };
}

function renderBullets(items: string[], emptyText = "None specified"): string {
  if (!items.length) return `- ${emptyText}`;
  return items.map((item) => `- ${item}`).join("\n");
}

function buildRankedItemHeadings(keyword: string, count: number, label: string): string[] {
  return Array.from({ length: count }, (_, index) => `${label} #${index + 1}: [Insert actual ${label.toLowerCase()} name]`);
}

function renderStructuredBrief(
  keyword: string,
  country: string | undefined,
  brief: StructuredBrief
): string {
  const sectionBlocks = brief.sections.map((section) => {
    const subsections = section.subsections.map((subsection) => {
      return [
        `  H3: ${subsection.heading}`,
        `  Purpose: ${subsection.purpose}`,
        `  Coverage Checklist:`,
        ...safeStringArray(subsection.must_cover).map((item) => `  - ${item}`),
      ].join("\n");
    }).join("\n\n");

    return [
      `${section.level}: ${section.heading}`,
      `Purpose: ${section.purpose}`,
      `Section Type: ${section.section_type}`,
      `Writer Must Cover:`,
      renderBullets(section.must_cover),
      `Research Needed:`,
      renderBullets(section.research_needed),
      `Differentiation Notes:`,
      renderBullets(section.differentiation),
      `Competitor Examples:`,
      renderBullets(section.examples),
      `Watch Out For:`,
      renderBullets(section.watch_out_for),
      subsections,
    ].filter(Boolean).join("\n");
  }).join("\n\n===================================\n\n");

  const competitorRefs = brief.competitor_references.map((reference, index) => {
    return `${index + 1}. ${reference.title} | ${reference.url} | Why it matters: ${reference.why_it_matters}`;
  }).join("\n");

  return `CONTENT BRIEF: ${keyword}
COUNTRY / REGION: ${country || "Not specified"}

===================================
PAGE TITLE OPTIONS
===================================
${brief.title_options.map((title, index) => `${index + 1}. ${title}`).join("\n")}

===================================
OUTLINE & WRITER INSTRUCTIONS
===================================
H1: ${brief.h1}
Search Angle: ${brief.search_angle}
Target Reader: ${brief.target_persona}
Word Count Range: ${brief.word_count_range}

${sectionBlocks}

===================================
ITEM DETAIL TEMPLATE
===================================
${renderBullets(brief.item_template, "Use the section-specific writer notes above.")}

===================================
COMPARISON / EVALUATION POINTS
===================================
${renderBullets(brief.comparison_points)}

===================================
FAQS
===================================
${brief.faq_questions.map((question, index) => `${index + 1}. ${question}`).join("\n")}

===================================
COMPETITOR REFERENCES
===================================
${competitorRefs || "No competitor references captured."}

===================================
CONTENT GAPS & OPPORTUNITIES
===================================
${renderBullets(brief.content_gaps)}`;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripHtmlTags(value: string): string {
  return value
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function sanitizeForExcel(value: string): string {
  return value
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\uFFFD/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function sanitizeGeneratedArticle(value: string): string {
  return sanitizeForExcel(stripHtmlTags(value))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function convertMarkdownHeadingsToOutlineLabels(value: string): string {
  return value
    .replace(/^####\s+(.+)$/gm, "H3: $1")
    .replace(/^###\s+(.+)$/gm, "H3: $1")
    .replace(/^##\s+(.+)$/gm, "H2: $1")
    .replace(/^#\s+(.+)$/gm, "H1: $1");
}

function countWords(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function buildFallbackArticleDraft(
  keyword: string,
  country: string | undefined,
  brief: StructuredBrief
): string {
  const intro = `H1: ${brief.h1}

If you are searching for ${keyword}${country ? ` in ${country}` : ""}, this guide gives you a practical, detailed overview based on the current search landscape and the most relevant entities tied to this topic.`;

  const sections = brief.sections.map((section) => {
    const sectionBody = [
      `H2: ${section.heading}`,
      `${section.purpose} This section should explain the topic clearly, add context, and give the reader enough detail to understand the main decisions, risks, options, or examples tied to the keyword.`,
      section.must_cover.length
        ? `Key points to cover in depth include ${section.must_cover.join(", ")}. Expand on each one with practical explanation instead of only naming it.`
        : "",
      ...section.subsections.map((subsection) => {
        const checklist = subsection.must_cover.length ? subsection.must_cover.join(", ") : "practical details and examples";
        return `H3: ${subsection.heading}
${subsection.purpose} In this part, explain ${checklist} in a way that a reader could directly use inside the final article without further rewriting.`;
      }),
    ].filter(Boolean).join("\n\n");
    return sectionBody;
  }).join("\n\n");

  const faqs = brief.faq_questions.length
    ? `H2: FAQs
\n${brief.faq_questions.map((question) => `H3: ${question}\nProvide a clear, direct, keyword-specific answer tailored to the reader intent.`).join("\n\n")}`
    : "";

  return [intro, sections, faqs].filter(Boolean).join("\n\n");
}

async function openaiGenerateArticleDraft(
  keyword: string,
  country: string | undefined,
  brief: StructuredBrief,
  keywordSignals: KeywordSignals,
  entityEnrichment: EntityEnrichment,
  serpInsights: AggregatedSerpInsights,
  searchResults: SearchResult[]
): Promise<string> {
  const minimumWords = keywordSignals.primarySubject === "tools" || keywordSignals.listCount ? 1400 : 1100;
  const entityList = dedupeStrings([
    ...entityEnrichment.profiles.map((profile) => profile.name),
    ...serpInsights.recurringEntities,
    ...serpInsights.itemCandidates,
  ], 20);
  const prompt = `You are an expert SEO writer. Write a full, paste-ready article draft.

KEYWORD: ${keyword}
COUNTRY / REGION: ${country || "Not specified"}
KEYWORD SIGNALS:
${compactJson(keywordSignals)}

STRUCTURED BRIEF:
${compactJson(brief)}

PRIORITY ENTITIES / ITEMS:
${compactJson(entityList)}

SERP INSIGHTS:
${compactJson(serpInsights)}

TOP REFERENCES:
${formatSearchResults(searchResults.slice(0, 5))}

TASK:
- Return ONLY the full article draft.
- Use this exact heading syntax in plain text:
  H1: Main title
  H2: Section heading
  H3: Subsection heading
- Actually write the content under each heading.
- Do NOT write "writer notes", "must cover", or planning language.
- Do NOT include HTML tags anywhere in the output.
- Include concrete keyword-relevant details, examples, and useful specificity.
- Make the content directly usable in an article without additional rewriting.
- The article must be clearly about the exact keyword, not generic advice.
- If the keyword is a list query, include actual item names and write a real section for each one.
- If the keyword is about tools, include actual tool names, what each tool does, use cases, strengths, weaknesses, pricing/free plan context, and alternatives where relevant.
- For local healthcare/service keywords, keep the article centered on the exact condition/service and local treatment, diagnosis, symptoms, and provider options relevant to the location.
- Use the priority entities/items when they fit the keyword. Do not use placeholders like "Tool 1" or "Restaurant 1".
- Keep the tone clear and practical.
- Target at least ${minimumWords} words unless the brief structure makes that impossible.
- Make every H2 section substantive. Aim for at least 120 words under each main section, and at least 70 words under each important H3 where applicable.
- Include an FAQ section if faq_questions are present.

Output must be publishable draft text, not instructions.`;

  return withRetry(async () => {
    const response = await openai.chat.completions.create({
      model: getModelName(),
      messages: [{ role: "user", content: prompt }],
    });
    return (response.choices[0].message.content || "").trim();
  }, 3, 4000);
}

async function openaiExpandArticleDraft(
  keyword: string,
  country: string | undefined,
  draft: string,
  brief: StructuredBrief,
  keywordSignals: KeywordSignals
): Promise<string> {
  const minimumWords = keywordSignals.primarySubject === "tools" || keywordSignals.listCount ? 1400 : 1100;
  const prompt = `Expand and improve this article draft.

KEYWORD: ${keyword}
COUNTRY / REGION: ${country || "Not specified"}
MINIMUM WORD TARGET: ${minimumWords}

STRUCTURED BRIEF:
${compactJson(brief)}

CURRENT DRAFT:
${draft}

TASK:
- Return only the improved full article.
- Keep the exact heading style: H1:, H2:, H3:
- Make the article more detailed and more keyword-specific.
- Add depth, examples, and useful explanation.
- Remove generic filler.
- Do not include HTML tags.
- Ensure the result is comfortably above the minimum word target if possible.`;

  return withRetry(async () => {
    const response = await openai.chat.completions.create({
      model: getModelName(),
      messages: [{ role: "user", content: prompt }],
    });
    return (response.choices[0].message.content || "").trim();
  }, 2, 4000);
}

function extractListCount(keyword: string): number | undefined {
  const match = keyword.match(/\b(?:top|best|leading)\s+(\d{1,2})\b/i) || keyword.match(/\b(\d{1,2})\s+(?:best|top)\b/i);
  if (!match) return undefined;
  const count = Number(match[1]);
  return Number.isFinite(count) ? count : undefined;
}

function deriveKeywordSignals(keyword: string, country?: string): KeywordSignals {
  const lowerKeyword = keyword.toLowerCase();
  const listCount = extractListCount(lowerKeyword);
  const modifierTerms = Array.from(new Set(lowerKeyword.match(/\b(?:best|top|vs|comparison|review|reviews|pricing|cost|near me|in|for|guide|how to|what is|examples|template|tools|software|hotels|restaurants|cafes|coffee shops|agencies)\b/g) || []));
  const localeHints = Array.from(new Set([
    ...(country ? [country] : []),
    ...(keyword.match(/\b(?:in|near|around|from)\s+([A-Za-z\s]{2,40})$/i)?.slice(1) || []),
  ].map((item) => item.trim()).filter(Boolean)));

  const isComparison = /\b(vs|versus|compare|comparison)\b/i.test(lowerKeyword);
  const isListicle = /\b(best|top|list|ideas|examples|types)\b/i.test(lowerKeyword) || Boolean(listCount);
  const isLocal = /\b(in|near|around)\b/i.test(lowerKeyword) || Boolean(country);
  const isHowTo = /\b(how to|guide|tips|ways|what is)\b/i.test(lowerKeyword);
  const isCommercial = /\b(price|pricing|cost|buy|service|agency|company|software|tool|tools|platform)\b/i.test(lowerKeyword);
  const isHospitality = /\b(hotel|hotels|restaurant|restaurants|cafe|cafes|coffee shop|coffee shops|resort|resorts|bar|bars)\b/i.test(lowerKeyword);
  const isToolKeyword = /\b(tool|tools|software|app|apps|platform|platforms|ai tool|ai tools)\b/i.test(lowerKeyword);
  const primarySubject = isToolKeyword
    ? "tools"
    : isHospitality
      ? "venues"
      : isComparison
        ? "compared options"
        : "topic";

  let keywordType = "informational";
  let articleFormat = "guide";
  let inferredIntent = "informational";
  let dataPoints = ["search intent alignment", "key subtopics", "common competitor sections"];
  let sectionPatterns = ["overview", "main topic coverage", "supporting FAQs"];
  let mandatorySections = ["direct intent match", "SERP-aligned coverage"];
  let itemDetailRequirements = ["specific examples", "real-world relevance"];

  if (isComparison) {
    keywordType = "comparison";
    articleFormat = "comparison page";
    inferredIntent = "commercial investigation";
    dataPoints = ["comparison criteria", "feature differences", "pricing", "best-fit use cases", "pros and cons"];
    sectionPatterns = ["comparison table", "head-to-head criteria", "best for X"];
    mandatorySections = ["comparison framework", "head-to-head breakdown", "best choice by use case"];
    itemDetailRequirements = ["feature differences", "pros and cons", "pricing", "fit by audience"];
  } else if (isListicle && isLocal && isHospitality) {
    keywordType = "localized ranked list";
    articleFormat = "ranked local listicle";
    inferredIntent = "local commercial investigation";
    dataPoints = ["ranked entities", "neighborhood/location", "price range", "signature offering", "amenities", "booking details", "why it stands out"];
    sectionPatterns = ["ranked list", "selection methodology", "map/area guidance", "booking tips"];
    mandatorySections = ["selection criteria", "ranked venues", "location guidance", "practical visit details"];
    itemDetailRequirements = ["location", "price range", "standout features", "who it suits", "drawbacks", "booking or visit info"];
  } else if (isListicle) {
    keywordType = "ranked list";
    articleFormat = "listicle";
    inferredIntent = isCommercial ? "commercial investigation" : "informational";
    dataPoints = ["ranked items", "selection criteria", "use cases", "pricing or accessibility", "pros and cons"];
    sectionPatterns = ["ranked picks", "how we chose", "best for segments"];
    mandatorySections = ["selection criteria", "ranked list", "best by use case"];
    itemDetailRequirements = ["what it is", "best use cases", "advantages", "disadvantages", "pricing", "alternatives"];
  } else if (isHowTo) {
    keywordType = "how-to";
    articleFormat = "step-by-step guide";
    inferredIntent = "informational";
    dataPoints = ["process steps", "requirements", "mistakes to avoid", "examples"];
    sectionPatterns = ["steps", "requirements", "examples", "FAQ"];
    mandatorySections = ["step-by-step process", "requirements", "mistakes to avoid", "examples"];
    itemDetailRequirements = ["step detail", "practical examples", "pitfalls", "expected outcomes"];
  } else if (isCommercial) {
    keywordType = "commercial page";
    articleFormat = "buyer guide";
    inferredIntent = "commercial investigation";
    dataPoints = ["features", "pricing", "fit by audience", "alternatives", "selection criteria"];
    sectionPatterns = ["features", "pricing", "buyer advice", "alternatives"];
    mandatorySections = ["features", "pricing", "best for audience segments", "alternatives"];
    itemDetailRequirements = ["feature coverage", "pricing", "fit", "limitations"];
  }

  if (isToolKeyword) {
    dataPoints = Array.from(new Set([
      ...dataPoints,
      "free plan details",
      "paid plan details",
      "student use cases",
      "setup or onboarding complexity",
      "alternatives",
    ]));
    sectionPatterns = ["evaluation criteria", "tool-by-tool breakdown", "free vs paid", "best alternatives", "use-case recommendations"];
    mandatorySections = [
      "evaluation criteria",
      "ranked tools",
      "tool-by-tool breakdown",
      "free vs paid comparison",
      "best alternatives by student use case",
    ];
    itemDetailRequirements = [
      "what the tool does",
      "how students can use it",
      "advantages",
      "disadvantages",
      "free plan",
      "paid plans",
      "best alternative options",
    ];
  }

  return {
    keywordType,
    inferredIntent,
    articleFormat,
    listCount,
    primarySubject,
    modifierTerms,
    localeHints,
    requiresLocalSpecifics: isLocal || isHospitality,
    dataPoints,
    sectionPatterns,
    mandatorySections,
    itemDetailRequirements,
  };
}

async function openaiClassifyIntent(
  keyword: string,
  country: string | undefined,
  keywordSignals: KeywordSignals,
  searchResults: SearchResult[]
): Promise<IntentProfile> {
  const prompt = `You are classifying a content-brief keyword before planning the brief.

KEYWORD: ${keyword}
COUNTRY / REGION: ${country || "Not specified"}
HEURISTIC SIGNALS:
${compactJson(keywordSignals)}

TOP SERP RESULTS:
${formatSearchResults(searchResults.slice(0, 5))}

TASK:
Return a JSON object that sharpens the keyword classification.

Rules:
- Keep the brief aligned to the actual SERP, not a reusable template.
- If the keyword is a ranked/local/tool query, say so explicitly.
- If the keyword needs entity-level coverage, set needsEntityLevelCoverage=true.
- If the keyword needs item-by-item coverage, set needsItemByItemCoverage=true.
- For "best/top tools" keywords, require tool-by-tool depth.
- For restaurant/hotel/local venue ranked keywords, require one ranked item subsection per entity.

Return JSON with this shape:
{
  "keywordType": "...",
  "inferredIntent": "...",
  "articleFormat": "...",
  "primarySubject": "...",
  "audience": "...",
  "freshnessExpectation": "...",
  "needsEntityLevelCoverage": true,
  "needsItemByItemCoverage": true,
  "targetItemCount": 10,
  "mandatoryCoverage": ["..."],
  "preferredSectionPatterns": ["..."],
  "avoidedPatterns": ["..."],
  "qualityTargets": ["..."]
}`;

  return withRetry(async () => {
    const response = await openai.chat.completions.create({
      model: getModelName(),
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const content = response.choices[0].message.content || "{}";
    const parsed = JSON.parse(content) as Partial<IntentProfile>;
    return {
      keywordType: String(parsed.keywordType || keywordSignals.keywordType),
      inferredIntent: String(parsed.inferredIntent || keywordSignals.inferredIntent),
      articleFormat: String(parsed.articleFormat || keywordSignals.articleFormat),
      primarySubject: String(parsed.primarySubject || keywordSignals.primarySubject),
      audience: String(parsed.audience || "Searchers who want an intent-matched, practical brief."),
      freshnessExpectation: String(parsed.freshnessExpectation || "Current information aligned to the live SERP."),
      needsEntityLevelCoverage: Boolean(parsed.needsEntityLevelCoverage ?? (keywordSignals.primarySubject === "venues" || keywordSignals.primarySubject === "tools")),
      needsItemByItemCoverage: Boolean(parsed.needsItemByItemCoverage ?? (Boolean(keywordSignals.listCount) || keywordSignals.primarySubject === "tools")),
      targetItemCount: safeNumber(parsed.targetItemCount, keywordSignals.listCount || (keywordSignals.primarySubject === "tools" ? 8 : 0)),
      mandatoryCoverage: dedupeStrings([...(parsed.mandatoryCoverage || []), ...keywordSignals.mandatorySections], 20),
      preferredSectionPatterns: dedupeStrings([...(parsed.preferredSectionPatterns || []), ...keywordSignals.sectionPatterns], 20),
      avoidedPatterns: dedupeStrings(parsed.avoidedPatterns || [], 20),
      qualityTargets: dedupeStrings([
        ...(parsed.qualityTargets || []),
        "Match real SERP intent",
        "Avoid generic repeated sections",
        "Include enough depth for each major entity or item",
      ], 20),
    };
  });
}

function formatSearchResults(results: SearchResult[]): string {
  return results.map((result) => {
    return [
      `Position: ${result.position || "-"}`,
      `Title: ${normalizeWhitespace(result.title || "")}`,
      `URL: ${result.link}`,
      `Snippet: ${normalizeWhitespace(result.snippet || "")}`,
    ].join("\n");
  }).join("\n\n---\n\n");
}

function resolveCountryCode(country?: string): string | undefined {
  if (!country) return undefined;

  const normalized = country.trim().toLowerCase();
  const countryMap: Record<string, string> = {
    australia: "au",
    au: "au",
    "united states": "us",
    usa: "us",
    us: "us",
    india: "in",
    in: "in",
    canada: "ca",
    ca: "ca",
    "united kingdom": "gb",
    uk: "gb",
    gb: "gb",
    "great britain": "gb",
    "new zealand": "nz",
    nz: "nz",
    "south africa": "za",
    za: "za",
  };

  if (countryMap[normalized]) return countryMap[normalized];
  if (/^[a-z]{2}$/i.test(normalized)) return normalized;
  return undefined;
}

async function googleSearch(keyword: string, country?: string): Promise<SearchResult[]> {
  const apiKey = SERPER_API_KEY();
  if (!apiKey) {
    throw new Error("Missing SERPER_API_KEY in environment variables");
  }

  const body: any = { q: keyword, num: 10 };

  const gl = resolveCountryCode(country);
  if (gl) {
    body.gl = gl;
    log(`Searching with country code (gl): ${gl}`, "workflow");
  } else if (country) {
    log(`No supported country code mapping found for "${country}". Running SERP search without gl.`, "workflow");
  }

  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Serper API error: ${response.status}`);
  }

  const data = await response.json();
  const organic = (data.organic || []) as SearchResult[];
  if (organic.length === 0) {
    throw new Error(`Serper returned no organic results for "${keyword}"${country ? ` in ${country}` : ""}`);
  }
  return organic;
}

function filterSearchResults(results: SearchResult[], keyword: string): { filtered_results: SearchResult[]; keyword: string } {
  const cleanResults: SearchResult[] = [];
  for (const result of results) {
    if (!result.link) continue;
    if (shouldExclude(result.link)) continue;
    cleanResults.push({
      title: result.title || "",
      link: result.link,
      snippet: result.snippet || "",
      position: result.position || 0,
    });
    if (cleanResults.length >= 10) break;
  }
  return { filtered_results: cleanResults, keyword };
}

async function openaiFilterTopUrls(filteredResults: SearchResult[], keyword: string): Promise<SearchResult[]> {
  const promptText = `SEARCH RESULTS:

${JSON.stringify(filteredResults, null, 2)}

KEYWORD: ${keyword}

TASK: From the search results above, select the best 5 URLs that would provide the most comprehensive information for creating a content brief about '${keyword}'.

Exclude any URLs that:
- Cannot be scraped (dynamic sites, login required)
- Are from social media, forums, or review sites
- Are too general or not specific to the keyword

Return ONLY a JSON object with this exact structure:
{
  "urls": [
    {"title": "...", "link": "...", "snippet": "..."},
    {"title": "...", "link": "...", "snippet": "..."}
  ]
}

No other text or explanation.`;

  return withRetry(async () => {
    const response = await openai.chat.completions.create({
      model: getModelName(),
      messages: [{ role: "user", content: promptText }],
      response_format: { type: "json_object" },
    });

    const contentText = response.choices[0].message.content || "{}";
    
    try {
      const parsed = JSON.parse(contentText);
      const urls = Array.isArray(parsed) ? parsed : (parsed.urls || parsed.results || Object.values(parsed)[0]);
      return Array.isArray(urls) && urls.length > 0 ? urls.slice(0, 5) : filteredResults.slice(0, 5);
    } catch {
      return filteredResults.slice(0, 5);
    }
  });
}

async function scrapeWebsite(url: string): Promise<string> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ContentBriefBot/1.0)",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    clearTimeout(timeout);

    if (!response.ok) return "Content not available";

    const html = await response.text();
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
    const headings = Array.from(html.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi))
      .slice(0, 30)
      .map(([, level, content]) => `H${level}: ${normalizeWhitespace(content.replace(/<[^>]+>/g, " "))}`)
      .filter(Boolean)
      .join("\n");
    const listItems = Array.from(html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi))
      .slice(0, 40)
      .map(([, content]) => normalizeWhitespace(content.replace(/<[^>]+>/g, " ")))
      .filter((item) => item.length > 2)
      .join("\n");

    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();

    return [
      title ? `PAGE TITLE: ${normalizeWhitespace(title)}` : "",
      headings ? `HEADINGS:\n${headings}` : "",
      listItems ? `LIST ITEMS:\n${listItems}` : "",
      `BODY:\n${text.substring(0, 14000)}`,
    ].filter(Boolean).join("\n\n");
  } catch {
    return "Content not available";
  }
}

function extractHeuristicInsightFromContent(content: string, sourceUrl: string): CompetitorInsight {
  const lines = content.split("\n").map((line) => line.trim()).filter(Boolean);
  const pageTitleLine = lines.find((line) => line.startsWith("PAGE TITLE:"));
  const pageTitle = pageTitleLine ? pageTitleLine.replace("PAGE TITLE:", "").trim() : sourceUrl;
  const headings = lines.filter((line) => /^H[1-3]:\s+/i.test(line)).slice(0, 20);
  const listItemLines = (() => {
    const start = lines.findIndex((line) => line === "LIST ITEMS:");
    if (start === -1) return [] as string[];
    return lines.slice(start + 1, start + 25).filter((line) => line.length > 3);
  })();
  return {
    source_url: sourceUrl,
    page_title: pageTitle,
    content_format: listItemLines.length ? "listicle" : "article",
    estimated_word_count: Math.max(0, Math.floor(content.length / 6)),
    headings,
    common_themes: headings.map((line) => line.replace(/^H[1-3]:\s+/i, "")).slice(0, 8),
    unique_angles: [],
    notable_features: listItemLines.length ? ["list items"] : [],
    named_entities: listItemLines.slice(0, 12),
    factual_attributes: [],
    locale_signals: [],
    item_candidates: listItemLines.slice(0, 15),
    faq_candidates: [],
    pricing_mentions: [],
    comparison_dimensions: [],
  };
}

async function openaiExtractCompetitorInsight(
  content: string,
  sourceUrl: string,
  keyword: string,
  country: string | undefined,
  intentProfile: IntentProfile
): Promise<CompetitorInsight> {
  const prompt = `WEBPAGE CONTENT:

${content}

SOURCE URL: ${sourceUrl}
KEYWORD: ${keyword}
COUNTRY / REGION: ${country || "Not specified"}
INTENT PROFILE:
${compactJson(intentProfile)}

TASK:
Extract structured competitor intelligence from this page for content-brief generation.

Rules:
- Focus only on information relevant to the keyword.
- Pull out real entities, concrete attributes, and section patterns.
- If this is a list query, capture ranked items or examples explicitly mentioned.
- If this is a tools query, capture tools, pricing, use cases, and comparison angles.
- If this is a local/venue query, capture places, menu/signature items when present, locations, and visit/booking details.
- Keep arrays concise and specific.

Return JSON with this shape:
{
  "source_url": "${sourceUrl}",
  "page_title": "...",
  "content_format": "...",
  "estimated_word_count": 1200,
  "headings": ["H1: ...", "H2: ..."],
  "common_themes": ["..."],
  "unique_angles": ["..."],
  "notable_features": ["..."],
  "named_entities": ["..."],
  "factual_attributes": ["..."],
  "locale_signals": ["..."],
  "item_candidates": ["..."],
  "faq_candidates": ["..."],
  "pricing_mentions": ["..."],
  "comparison_dimensions": ["..."]
}`;

  return withRetry(async () => {
    const response = await openai.chat.completions.create({
      model: getModelName(),
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0].message.content || "{}";
    const parsed = JSON.parse(raw) as Partial<CompetitorInsight>;
    return {
      source_url: sourceUrl,
      page_title: String(parsed.page_title || ""),
      content_format: String(parsed.content_format || ""),
      estimated_word_count: safeNumber(parsed.estimated_word_count),
      headings: safeStringArray(parsed.headings),
      common_themes: safeStringArray(parsed.common_themes),
      unique_angles: safeStringArray(parsed.unique_angles),
      notable_features: safeStringArray(parsed.notable_features),
      named_entities: safeStringArray(parsed.named_entities),
      factual_attributes: safeStringArray(parsed.factual_attributes),
      locale_signals: safeStringArray(parsed.locale_signals),
      item_candidates: safeStringArray(parsed.item_candidates),
      faq_candidates: safeStringArray(parsed.faq_candidates),
      pricing_mentions: safeStringArray(parsed.pricing_mentions),
      comparison_dimensions: safeStringArray(parsed.comparison_dimensions),
    };
  });
}

function aggregateCompetitorInsights(insights: CompetitorInsight[]): AggregatedSerpInsights {
  const topHeadings = dedupeStrings(insights.flatMap((insight) => insight.headings), 30);
  const recurringThemes = dedupeStrings(insights.flatMap((insight) => insight.common_themes), 25);
  const recurringEntities = dedupeStrings(insights.flatMap((insight) => insight.named_entities), 40);
  const recurringAttributes = dedupeStrings(insights.flatMap((insight) => insight.factual_attributes), 40);
  const recurringFaqs = dedupeStrings(insights.flatMap((insight) => insight.faq_candidates), 12);
  const itemCandidates = dedupeStrings(insights.flatMap((insight) => insight.item_candidates), 30);
  const pricingSignals = dedupeStrings(insights.flatMap((insight) => insight.pricing_mentions), 20);
  const comparisonDimensions = dedupeStrings(insights.flatMap((insight) => insight.comparison_dimensions), 20);
  const localeSignals = dedupeStrings(insights.flatMap((insight) => insight.locale_signals), 20);
  const contentFormats = dedupeStrings(insights.map((insight) => insight.content_format), 10);
  const opportunities = dedupeStrings(insights.flatMap((insight) => insight.unique_angles), 20);

  return {
    topHeadings,
    recurringThemes,
    recurringEntities,
    recurringAttributes,
    recurringFaqs,
    itemCandidates,
    pricingSignals,
    comparisonDimensions,
    localeSignals,
    contentFormats,
    opportunities,
    examplesByUrl: insights.map((insight) => ({
      url: insight.source_url,
      title: insight.page_title || insight.source_url,
      winning_angles: insight.unique_angles.slice(0, 3),
      entities: insight.named_entities.slice(0, 5),
      attributes: insight.factual_attributes.slice(0, 5),
    })),
  };
}

function buildFallbackIntentProfile(keywordSignals: KeywordSignals): IntentProfile {
  return {
    keywordType: keywordSignals.keywordType,
    inferredIntent: keywordSignals.inferredIntent,
    articleFormat: keywordSignals.articleFormat,
    primarySubject: keywordSignals.primarySubject,
    audience: "Searchers looking for a specific, practical content brief.",
    freshnessExpectation: "Use current SERP-aligned information where possible.",
    needsEntityLevelCoverage: keywordSignals.primarySubject === "venues" || keywordSignals.primarySubject === "tools",
    needsItemByItemCoverage: Boolean(keywordSignals.listCount) || keywordSignals.primarySubject === "tools",
    targetItemCount: keywordSignals.listCount || (keywordSignals.primarySubject === "tools" ? 8 : 0),
    mandatoryCoverage: [...keywordSignals.mandatorySections],
    preferredSectionPatterns: [...keywordSignals.sectionPatterns],
    avoidedPatterns: ["generic filler", "repeated template sections"],
    qualityTargets: ["specificity", "coverage depth", "intent match"],
  };
}

function buildFallbackBlueprint(
  keyword: string,
  country: string | undefined,
  keywordSignals: KeywordSignals,
  intentProfile: IntentProfile,
  serpInsights: AggregatedSerpInsights
): BriefBlueprint {
  const baseH2s = intentProfile.primarySubject === "tools"
    ? [
        {
          heading: `How We Evaluated ${keyword}`,
          purpose: "Explain ranking criteria.",
          keyPoints: ["evaluation criteria", "target audience fit", "pricing", "ease of use"],
          examples: [],
          watchOutFor: ["generic criteria"],
          h3s: [],
        },
        {
          heading: `Best ${keyword}`,
          purpose: "Make the tools themselves the center of the brief.",
          keyPoints: keywordSignals.itemDetailRequirements,
          examples: [],
          watchOutFor: ["tool names without enough depth"],
          h3s: serpInsights.itemCandidates.slice(0, keywordSignals.listCount || 8),
        },
      ]
    : [
        {
          heading: `Core Coverage for ${keyword}`,
          purpose: "Match the dominant SERP intent with direct coverage.",
          keyPoints: keywordSignals.dataPoints,
          examples: [],
          watchOutFor: ["generic sections"],
          h3s: serpInsights.topHeadings.slice(0, 6),
        },
      ];

  return {
    inferredIntent: intentProfile.inferredIntent,
    articleFormat: intentProfile.articleFormat,
    searchAngle: `Create an intent-matched brief for ${keyword}${country ? ` in ${country}` : ""}.`,
    localeFocus: country ? `Use ${country}-specific framing and references.` : "Follow the dominant locale in the SERP.",
    suggestedTitleAngles: [
      `${keyword}: Complete Brief`,
      `Best Angle for ${keyword}`,
      `${keyword}: SEO Content Brief`,
    ],
    recommendedH2s: baseH2s,
    requiredDataPoints: dedupeStrings([...keywordSignals.dataPoints, ...serpInsights.recurringAttributes], 20),
    sectionsToAvoid: ["generic introduction-only sections"],
    secondaryKeywords: serpInsights.recurringThemes.slice(0, 8),
    longTailKeywords: serpInsights.recurringFaqs.slice(0, 8),
    semanticTerms: dedupeStrings([...serpInsights.recurringThemes, ...serpInsights.recurringAttributes], 20),
    entities: serpInsights.recurringEntities.slice(0, 20),
    faqQuestions: serpInsights.recurringFaqs.slice(0, 8),
    opportunities: serpInsights.opportunities.slice(0, 10),
    pageGoal: "Give the writer a detailed, practical, SERP-aligned brief.",
    persona: intentProfile.audience,
    wordCountRange: "1,500 - 2,500 words",
    pageFormat: intentProfile.articleFormat,
    metaDescriptionAngles: [
      `Get a detailed content brief for ${keyword}.`,
      `SERP-aligned brief for ${keyword} with section-level writer guidance.`,
    ],
  };
}

function buildFallbackOutlinePlan(
  keyword: string,
  keywordSignals: KeywordSignals,
  blueprint: BriefBlueprint,
  entityEnrichment: EntityEnrichment
): OutlinePlan {
  const sections: DraftBriefSection[] = blueprint.recommendedH2s.map((section) => ({
    level: "H2",
    heading: section.heading,
    purpose: section.purpose,
    section_type: "core",
    must_cover: section.keyPoints.length ? section.keyPoints : keywordSignals.dataPoints,
    research_needed: blueprint.requiredDataPoints,
    differentiation: blueprint.opportunities,
    examples: section.examples,
    watch_out_for: section.watchOutFor,
    subsections: section.h3s.length
      ? section.h3s.map((heading) => ({
          heading,
          purpose: `Cover ${heading} with specific, useful detail.`,
          must_cover: keywordSignals.itemDetailRequirements,
        }))
      : entityEnrichment.profiles.slice(0, keywordSignals.listCount || 6).map((profile) => ({
          heading: profile.name,
          purpose: `Cover ${profile.name} in depth.`,
          must_cover: profile.mustCover,
        })),
  }));

  return {
    h1: keyword,
    titleAngles: blueprint.suggestedTitleAngles.slice(0, 3),
    sections,
    comparisonPoints: keywordSignals.dataPoints.slice(0, 6),
    faqQuestions: blueprint.faqQuestions.slice(0, 8),
    itemTemplate: keywordSignals.itemDetailRequirements,
    opportunities: blueprint.opportunities,
  };
}

function buildFallbackStructuredBrief(
  keyword: string,
  country: string | undefined,
  blueprint: BriefBlueprint,
  outlinePlan: OutlinePlan,
  serpInsights: AggregatedSerpInsights,
  searchResults: SearchResult[],
  keywordSignals: KeywordSignals
): StructuredBrief {
  return {
    search_intent: blueprint.inferredIntent,
    search_angle: blueprint.searchAngle,
    article_type: blueprint.articleFormat,
    brief_summary: `Fallback brief generated for ${keyword} using available SERP intelligence and heuristic planning.`,
    title_options: outlinePlan.titleAngles.length ? outlinePlan.titleAngles : blueprint.suggestedTitleAngles.slice(0, 3),
    h1: outlinePlan.h1 || keyword,
    sections: outlinePlan.sections,
    item_template: outlinePlan.itemTemplate.length ? outlinePlan.itemTemplate : keywordSignals.itemDetailRequirements,
    comparison_points: outlinePlan.comparisonPoints,
    faq_questions: outlinePlan.faqQuestions,
    word_count_range: blueprint.wordCountRange,
    page_goal: blueprint.pageGoal,
    target_persona: blueprint.persona,
    page_format: blueprint.pageFormat,
    meta_descriptions: blueprint.metaDescriptionAngles.slice(0, 2),
    url_slug: `/${keyword.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
    secondary_keywords: blueprint.secondaryKeywords,
    long_tail_keywords: blueprint.longTailKeywords,
    entities: blueprint.entities.length ? blueprint.entities : serpInsights.recurringEntities,
    semantic_terms: blueprint.semanticTerms,
    internal_links: [],
    external_linking_strategy: ["Link to authoritative supporting sources where appropriate."],
    media_ideas: ["Use screenshots, tables, or comparison visuals if relevant."],
    content_gaps: blueprint.opportunities,
    competitor_references: searchResults.slice(0, 5).map((result) => ({
      title: result.title,
      url: result.link,
      why_it_matters: result.snippet || "Competing SERP result.",
    })),
  };
}

function buildEntityEnrichment(
  keywordSignals: KeywordSignals,
  intentProfile: IntentProfile,
  serpInsights: AggregatedSerpInsights
): EntityEnrichment {
  const entityType = intentProfile.primarySubject === "tools"
    ? "tool"
    : intentProfile.primarySubject === "venues"
      ? "venue"
      : "entity";

  const baseMustCover = intentProfile.primarySubject === "tools"
    ? [
        "what it is",
        "how the target audience uses it",
        "top strengths",
        "main weaknesses",
        "free plan",
        "paid plans",
        "best alternatives",
      ]
    : intentProfile.primarySubject === "venues"
      ? [
          "location",
          "signature offering",
          "price range",
          "experience or ambiance",
          "why it stands out",
          "who it suits",
          "booking or visit notes",
        ]
      : keywordSignals.itemDetailRequirements;

  const names = dedupeStrings([
    ...serpInsights.itemCandidates,
    ...serpInsights.recurringEntities,
  ], Math.max(6, intentProfile.targetItemCount || 10));

  return {
    entityType,
    profiles: names.map((name) => ({
      name,
      whyItMatters: `Mentioned or implied by the target SERP as a relevant ${entityType}.`,
      mustCover: baseMustCover,
    })),
  };
}

async function openaiBuildBriefBlueprint(
  keyword: string,
  country: string | undefined,
  keywordSignals: KeywordSignals,
  intentProfile: IntentProfile,
  searchResults: SearchResult[],
  serpInsights: AggregatedSerpInsights
): Promise<BriefBlueprint> {
  const prompt = `You are an expert SEO strategist building a structured content brief plan.

KEYWORD: ${keyword}
COUNTRY / REGION: ${country || "Not specified"}
LOCAL KEYWORD SIGNALS:
${compactJson(keywordSignals)}

INTENT PROFILE:
${compactJson(intentProfile)}

TOP SERP RESULTS:
${formatSearchResults(searchResults)}

AGGREGATED SERP INSIGHTS:
${compactJson(serpInsights)}

TASK:
Return a JSON object that adapts the brief to the keyword's real intent and locale. Do not create a generic template.

Rules:
- If the keyword is a local list query, the outline must center on ranked entities, selection criteria, neighborhoods/areas, pricing, standout features, and booking/visit guidance.
- For restaurant, hotel, cafe, or venue keywords, the ranked list section must include one H3 entry for every requested item in the list whenever the keyword includes a number like top 10.
- For restaurant keywords, each venue entry must require cuisine type, location, signature dishes, price point, ambiance, why it stands out, who it suits, drawbacks, and booking advice.
- Only include food/menu/signature dish requirements when the keyword is clearly restaurant/cafe/food related.
- If the keyword is a software/product query, emphasize comparison criteria, pricing, features, use cases, and alternatives.
- If the keyword is a best/top tools query, you must make the outline tool-first, not advice-first. The main body should revolve around the tools themselves.
- For tool keywords, the recommended outline must explicitly include evaluation criteria, a tool-by-tool breakdown, free vs paid guidance, and best alternatives by use case.
- If the keyword is informational, emphasize definitions, process, examples, and practical applications.
- Use country/region context for spelling, examples, and local SERP expectations.
- Avoid filler sections that do not support the query intent.
- Base recommendations on the SERP and competitor analysis, not on a fixed reusable pattern.

Return JSON with this exact top-level shape:
{
  "inferredIntent": "...",
  "articleFormat": "...",
  "searchAngle": "...",
  "localeFocus": "...",
  "suggestedTitleAngles": ["...", "...", "..."],
  "recommendedH2s": [
    {
      "heading": "...",
      "purpose": "...",
      "keyPoints": ["...", "..."],
      "examples": ["..."],
      "watchOutFor": ["..."],
      "h3s": ["...", "..."]
    }
  ],
  "requiredDataPoints": ["...", "..."],
  "sectionsToAvoid": ["...", "..."],
  "secondaryKeywords": ["...", "..."],
  "longTailKeywords": ["...", "..."],
  "semanticTerms": ["...", "..."],
  "entities": ["...", "..."],
  "faqQuestions": ["...", "..."],
  "opportunities": ["...", "..."],
  "pageGoal": "...",
  "persona": "...",
  "wordCountRange": "...",
  "pageFormat": "...",
  "metaDescriptionAngles": ["...", "..."]
}`;

  return withRetry(async () => {
    const response = await openai.chat.completions.create({
      model: getModelName(),
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const content = response.choices[0].message.content || "{}";
    const parsed = JSON.parse(content) as Partial<BriefBlueprint>;

    return {
      inferredIntent: parsed.inferredIntent || keywordSignals.inferredIntent,
      articleFormat: parsed.articleFormat || keywordSignals.articleFormat,
      searchAngle: parsed.searchAngle || `Create a ${keywordSignals.articleFormat} tailored to ${keyword}`,
      localeFocus: parsed.localeFocus || (country ? `Prioritize ${country}-specific framing and entities.` : "Use the dominant locale from the SERP."),
      suggestedTitleAngles: parsed.suggestedTitleAngles || [],
      recommendedH2s: Array.isArray(parsed.recommendedH2s) ? parsed.recommendedH2s : [],
      requiredDataPoints: parsed.requiredDataPoints || keywordSignals.dataPoints,
      sectionsToAvoid: parsed.sectionsToAvoid || [],
      secondaryKeywords: parsed.secondaryKeywords || [],
      longTailKeywords: parsed.longTailKeywords || [],
      semanticTerms: parsed.semanticTerms || [],
      entities: parsed.entities || [],
      faqQuestions: parsed.faqQuestions || [],
      opportunities: parsed.opportunities || [],
      pageGoal: parsed.pageGoal || "Match search intent with a more specific, more useful brief than the current top-ranking pages.",
      persona: parsed.persona || "Searchers evaluating this topic and looking for clear, practical guidance.",
      wordCountRange: parsed.wordCountRange || "1,500 - 2,500 words",
      pageFormat: parsed.pageFormat || keywordSignals.articleFormat,
      metaDescriptionAngles: parsed.metaDescriptionAngles || [],
    };
  });
}

async function openaiBuildOutlinePlan(
  keyword: string,
  country: string | undefined,
  keywordSignals: KeywordSignals,
  intentProfile: IntentProfile,
  blueprint: BriefBlueprint,
  serpInsights: AggregatedSerpInsights,
  entityEnrichment: EntityEnrichment
): Promise<OutlinePlan> {
  const prompt = `You are planning the exact H1/H2/H3 structure for a content brief.

KEYWORD: ${keyword}
COUNTRY / REGION: ${country || "Not specified"}
KEYWORD SIGNALS:
${compactJson(keywordSignals)}

INTENT PROFILE:
${compactJson(intentProfile)}

BLUEPRINT:
${compactJson(blueprint)}

SERP INSIGHTS:
${compactJson(serpInsights)}

ENTITY ENRICHMENT:
${compactJson(entityEnrichment)}

TASK:
Return a JSON plan for the actual outline before writer instructions are generated.

Rules:
- H1/H2/H3 structure is mandatory.
- Do not create generic filler sections.
- If this is a tool/list/venue query, the main body must revolve around the actual items.
- If targetItemCount is available, create enough H3 item subsections to match it when practical.
- Each section must have a clear purpose and strong must_cover checklist.
- Use concrete entities from SERP insights where possible.

Return JSON:
{
  "h1": "...",
  "titleAngles": ["...", "...", "..."],
  "sections": [
    {
      "level": "H2",
      "heading": "...",
      "purpose": "...",
      "section_type": "...",
      "must_cover": ["..."],
      "research_needed": ["..."],
      "differentiation": ["..."],
      "examples": ["..."],
      "watch_out_for": ["..."],
      "subsections": [
        {
          "heading": "...",
          "purpose": "...",
          "must_cover": ["..."]
        }
      ]
    }
  ],
  "comparisonPoints": ["..."],
  "faqQuestions": ["..."],
  "itemTemplate": ["..."],
  "opportunities": ["..."]
}`;

  return withRetry(async () => {
    const response = await openai.chat.completions.create({
      model: getModelName(),
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0].message.content || "{}";
    const parsed = JSON.parse(raw) as any;
    const sections: DraftBriefSection[] = Array.isArray(parsed.sections)
      ? parsed.sections.map((section: any) => ({
          level: section?.level === "H3" ? "H3" : "H2",
          heading: String(section?.heading || "").trim(),
          purpose: String(section?.purpose || "").trim(),
          section_type: String(section?.section_type || "core").trim(),
          must_cover: safeStringArray(section?.must_cover),
          research_needed: safeStringArray(section?.research_needed),
          differentiation: safeStringArray(section?.differentiation),
          examples: safeStringArray(section?.examples),
          watch_out_for: safeStringArray(section?.watch_out_for),
          subsections: Array.isArray(section?.subsections)
            ? section.subsections.map((subsection: any) => ({
                heading: String(subsection?.heading || "").trim(),
                purpose: String(subsection?.purpose || "").trim(),
                must_cover: safeStringArray(subsection?.must_cover),
              })).filter((subsection: any) => subsection.heading)
            : [],
        })).filter((section: DraftBriefSection) => section.heading)
      : [];

    return {
      h1: String(parsed.h1 || keyword),
      titleAngles: safeStringArray(parsed.titleAngles).slice(0, 3),
      sections,
      comparisonPoints: safeStringArray(parsed.comparisonPoints),
      faqQuestions: safeStringArray(parsed.faqQuestions),
      itemTemplate: safeStringArray(parsed.itemTemplate),
      opportunities: safeStringArray(parsed.opportunities),
    };
  });
}

async function openaiGenerateStructuredBrief(
  keyword: string,
  country: string | undefined,
  keywordSignals: KeywordSignals,
  intentProfile: IntentProfile,
  blueprint: BriefBlueprint,
  outlinePlan: OutlinePlan,
  searchResults: SearchResult[],
  serpInsights: AggregatedSerpInsights,
  entityEnrichment: EntityEnrichment
): Promise<StructuredBrief> {
  const prompt = `You are Britta, an expert content strategist AI that creates detailed content briefs.

KEYWORD: ${keyword}
COUNTRY / REGION: ${country || "Not specified"}
KEYWORD SIGNALS:
${compactJson(keywordSignals)}

INTENT PROFILE:
${compactJson(intentProfile)}

BRIEF BLUEPRINT:
${compactJson(blueprint)}

OUTLINE PLAN:
${compactJson(outlinePlan)}

TOP SERP RESULTS:
${formatSearchResults(searchResults)}

AGGREGATED SERP INSIGHTS:
${compactJson(serpInsights)}

ENTITY ENRICHMENT:
${compactJson(entityEnrichment)}

TASK:
Return a JSON object for a deep, keyword-specific content brief. Do not return prose outside JSON.

Rules:
- The brief must NOT reuse a generic section pattern across keywords.
- If the keyword is a "best/top/list" query, the brief must make the list itself the center of the outline.
- For software/tool keywords, include tool-by-tool depth requirements such as what it is, best use cases, how the target audience uses it, advantages, disadvantages, pricing, free plan, paid plan, and viable alternatives.
- For software/tool keywords, the sections array must explicitly include:
  1. evaluation criteria
  2. the ranked tools list
  3. a tool-by-tool breakdown section with H3s or equivalent coverage for individual tools
  4. free vs paid guidance
  5. alternatives or best-for-use-case recommendations
- For student tool keywords, every major tool subsection should require: what it is, how students can use it, strongest features, weaknesses, pricing, free plan, and alternatives.
- For local business/place keywords, include entity-level fields such as location, neighborhood, price range, standout features, who it suits, drawbacks, and booking/visit details.
- For restaurant keywords, if the keyword implies a ranked list, the output must include one subsection per restaurant entry and each subsection must require:
  1. actual restaurant name
  2. city or location
  3. cuisine style
  4. signature dishes or tasting menu highlights
  5. pricing or price range
  6. ambiance and dining experience
  7. why it stands out
  8. who it is best for
  9. drawbacks or considerations
  10. reservation or booking notes
- For comparison keywords, include clear comparison criteria and head-to-head decision factors.
- For informational/how-to keywords, include process depth, examples, mistakes, and implementation details.
- Do not add filler sections like "How to choose" unless they are strongly supported by the SERP.
- The sections array must contain substantive, unique sections with detailed writer guidance.
- Each section must have strong "must_cover" and "research_needed" arrays.
- Use competitor URLs as examples where useful.

Return JSON with this exact shape:
{
  "search_intent": "...",
  "search_angle": "...",
  "article_type": "...",
  "brief_summary": "...",
  "title_options": ["...", "...", "..."],
  "h1": "...",
  "sections": [
    {
      "level": "H2",
      "heading": "...",
      "purpose": "...",
      "section_type": "...",
      "must_cover": ["...", "..."],
      "research_needed": ["...", "..."],
      "differentiation": ["...", "..."],
      "examples": ["...", "..."],
      "watch_out_for": ["...", "..."],
      "subsections": [
        {
          "heading": "...",
          "purpose": "...",
          "must_cover": ["...", "..."]
        }
      ]
    }
  ],
  "item_template": ["...", "..."],
  "comparison_points": ["...", "..."],
  "faq_questions": ["...", "..."],
  "word_count_range": "...",
  "page_goal": "...",
  "target_persona": "...",
  "page_format": "...",
  "meta_descriptions": ["...", "..."],
  "url_slug": "...",
  "secondary_keywords": ["...", "..."],
  "long_tail_keywords": ["...", "..."],
  "entities": ["...", "..."],
  "semantic_terms": ["...", "..."],
  "internal_links": ["...", "..."],
  "external_linking_strategy": ["...", "..."],
  "media_ideas": ["...", "..."],
  "content_gaps": ["...", "..."],
  "competitor_references": [
    {
      "title": "...",
      "url": "...",
      "why_it_matters": "..."
    }
  ]
}`;

  return withRetry(async () => {
    const response = await openai.chat.completions.create({
      model: getModelName(),
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const content = response.choices[0].message.content || "{}";
    const parsed = JSON.parse(content) as Partial<StructuredBrief>;
    const defaultToolSections: DraftBriefSection[] = keywordSignals.primarySubject === "tools" ? [
      {
        level: "H2" as const,
        heading: `How We Evaluated ${keyword}`,
        purpose: "Explain the criteria used to rank the tools so the article feels credible and useful.",
        section_type: "evaluation criteria",
        must_cover: ["selection criteria", "student needs", "pricing sensitivity", "free-plan usefulness"],
        research_needed: ["common student use cases", "pricing and free-tier availability", "current 2026 positioning where applicable"],
        differentiation: ["use practical student scenarios instead of vague feature lists"],
        examples: [],
        watch_out_for: ["generic criteria with no relevance to students"],
        subsections: [],
      },
      {
        level: "H2" as const,
        heading: `Best ${keyword}`,
        purpose: "Make the ranked tools list the core of the article.",
        section_type: "ranked tools list",
        must_cover: keywordSignals.itemDetailRequirements,
        research_needed: blueprint.requiredDataPoints,
        differentiation: ["include clear student use cases and pricing context for each tool"],
        examples: [],
        watch_out_for: ["listing tools without explaining how students use them"],
        subsections: (
          outlinePlan.sections.find((section) => section.subsections.length)?.subsections.length
            ? outlinePlan.sections.find((section) => section.subsections.length)!.subsections
            : entityEnrichment.profiles.map((profile) => ({
                heading: profile.name,
                purpose: `Break down ${profile.name} in depth for the target audience.`,
                must_cover: profile.mustCover,
              }))
        ).slice(0, keywordSignals.listCount || intentProfile.targetItemCount || 8).map((subsection) => ({
          heading: subsection.heading,
          purpose: subsection.purpose || "Break down one tool in depth.",
          must_cover: subsection.must_cover.length ? subsection.must_cover : keywordSignals.itemDetailRequirements,
        })),
      },
      {
        level: "H2" as const,
        heading: "Free vs Paid Plans",
        purpose: "Help students understand whether the free plan is enough or if an upgrade is worth paying for.",
        section_type: "pricing guidance",
        must_cover: ["free plan limitations", "paid upgrade value", "best budget picks", "where premium plans make sense"],
        research_needed: ["current free-tier details", "entry pricing", "student affordability considerations"],
        differentiation: ["focus on affordability and practical student workflows"],
        examples: [],
        watch_out_for: ["pricing claims without current verification"],
        subsections: [],
      },
      {
        level: "H2" as const,
        heading: "Best Alternatives by Student Use Case",
        purpose: "Recommend the right tool based on what the student actually needs to do.",
        section_type: "use-case mapping",
        must_cover: ["best for writing", "best for research", "best for presentations", "best for studying", "best free option"],
        research_needed: ["tool strengths by use case", "tradeoffs between options"],
        differentiation: ["map tools to real academic workflows"],
        examples: [],
        watch_out_for: ["same recommendation for every use case"],
        subsections: [],
      },
    ] : [];
    const defaultVenueSections: DraftBriefSection[] = keywordSignals.primarySubject === "venues" ? [
      {
        level: "H2" as const,
        heading: `Selection Criteria for ${keyword}`,
        purpose: "Explain exactly how the restaurants or venues were chosen so the ranking feels trustworthy.",
        section_type: "selection criteria",
        must_cover: ["food quality", "consistency", "signature dishes", "ambiance", "service", "value for money", "local reputation"],
        research_needed: ["current rankings or press mentions", "city/location details", "signature menu highlights", "pricing signals"],
        differentiation: ["use concrete dining criteria instead of vague praise"],
        examples: [],
        watch_out_for: ["generic criteria with no connection to dining experience"],
        subsections: [
          {
            heading: "Food Quality and Signature Dishes",
            purpose: "Define what makes a restaurant worth ranking.",
            must_cover: ["ingredient quality", "signature dishes", "chef reputation"],
          },
          {
            heading: "Experience, Service, and Value",
            purpose: "Balance food quality with the full dining experience.",
            must_cover: ["ambiance", "service", "price-value relationship"],
          },
        ],
      },
      {
        level: "H2" as const,
        heading: `Top ${keywordSignals.listCount || 10} Picks`,
        purpose: "This must be the main section of the article with one subsection per ranked venue.",
        section_type: "ranked venue list",
        must_cover: keywordSignals.itemDetailRequirements,
        research_needed: blueprint.requiredDataPoints,
        differentiation: ["each venue entry should feel like a mini-review, not just a mention"],
        examples: [],
        watch_out_for: ["listing names without enough venue-specific detail"],
        subsections: (
          entityEnrichment.profiles.length
            ? entityEnrichment.profiles.map((profile) => ({
                heading: profile.name,
                purpose: `Provide a deep venue-by-venue breakdown for ${profile.name}.`,
                must_cover: profile.mustCover.length ? profile.mustCover : [
                  "actual restaurant name",
                  "city or location",
                  "cuisine style",
                  "signature dishes or tasting menu highlights",
                  "pricing or price range",
                  "ambiance and dining experience",
                  "why it stands out",
                  "who it is best for",
                  "drawbacks or considerations",
                  "reservation or booking notes",
                ],
              }))
            : buildRankedItemHeadings(keyword, keywordSignals.listCount || 10, "Restaurant").map((heading) => ({
                heading,
                purpose: "Provide a deep venue-by-venue breakdown.",
                must_cover: [
                  "actual restaurant name",
                  "city or location",
                  "cuisine style",
                  "signature dishes or tasting menu highlights",
                  "pricing or price range",
                  "ambiance and dining experience",
                  "why it stands out",
                  "who it is best for",
                  "drawbacks or considerations",
                  "reservation or booking notes",
                ],
              }))
        ),
      },
      {
        level: "H2" as const,
        heading: "Best by Dining Occasion",
        purpose: "Help readers choose the right restaurant for different goals.",
        section_type: "use-case mapping",
        must_cover: ["best fine dining option", "best casual upscale option", "best for special occasions", "best value pick"],
        research_needed: ["venue positioning", "menu style", "experience type"],
        differentiation: ["turn the ranking into a practical decision guide"],
        examples: [],
        watch_out_for: ["repeating the same venue without explaining why it fits a use case"],
        subsections: [],
      },
      {
        level: "H2" as const,
        heading: "Booking Tips and What to Know Before You Go",
        purpose: "Add practical reader value beyond the ranking itself.",
        section_type: "practical guidance",
        must_cover: ["reservation timing", "dress code if relevant", "budget expectations", "special menu considerations"],
        research_needed: ["booking patterns", "venue policies", "premium dining expectations"],
        differentiation: ["give practical guidance that generic listicles usually miss"],
        examples: [],
        watch_out_for: ["guessing venue policies without evidence"],
        subsections: [],
      },
    ] : [];
    const fallbackSections: DraftBriefSection[] = (outlinePlan.sections.length ? outlinePlan.sections : blueprint.recommendedH2s.map((section) => ({
      level: "H2" as const,
      heading: section.heading,
      purpose: section.purpose,
      section_type: "core",
      must_cover: section.keyPoints,
      research_needed: blueprint.requiredDataPoints,
      differentiation: blueprint.opportunities,
      examples: section.examples,
      watch_out_for: section.watchOutFor,
      subsections: section.h3s.map((heading) => ({
        heading,
        purpose: `Support the section "${section.heading}" with a specific angle.`,
        must_cover: section.keyPoints,
      })),
    })));
    const parsedSections: DraftBriefSection[] = Array.isArray(parsed.sections)
      ? parsed.sections
          .map(normalizeDraftSection)
          .filter((section): section is DraftBriefSection => Boolean(section))
      : [];
    const parsedSubsectionCount = parsedSections.reduce((count, section) => count + section.subsections.length, 0);
    const venueMinimumSubsections = keywordSignals.primarySubject === "venues" ? Math.max(6, keywordSignals.listCount || 10) : 0;
    const toolMinimumSubsections = keywordSignals.primarySubject === "tools" ? Math.max(5, keywordSignals.listCount || 6) : 0;
    const shouldUseVenueFallback = keywordSignals.primarySubject === "venues" && parsedSubsectionCount < venueMinimumSubsections;
    const shouldUseToolFallback = keywordSignals.primarySubject === "tools" && parsedSubsectionCount < toolMinimumSubsections;
    const finalSections = shouldUseVenueFallback
      ? defaultVenueSections
      : shouldUseToolFallback
        ? defaultToolSections
        : parsedSections.length
          ? parsedSections
          : (defaultVenueSections.length ? defaultVenueSections : defaultToolSections.length ? defaultToolSections : fallbackSections);

    return {
      search_intent: parsed.search_intent || blueprint.inferredIntent,
      search_angle: parsed.search_angle || blueprint.searchAngle,
      article_type: parsed.article_type || blueprint.articleFormat,
      brief_summary: parsed.brief_summary || `Create a more detailed, intent-matched article for ${keyword}.`,
      title_options: safeStringArray(parsed.title_options).slice(0, 3).length
        ? safeStringArray(parsed.title_options).slice(0, 3)
        : (outlinePlan.titleAngles.length ? outlinePlan.titleAngles : blueprint.suggestedTitleAngles).slice(0, 3),
      h1: parsed.h1 || outlinePlan.h1 || keyword,
      sections: finalSections,
      item_template: safeStringArray(parsed.item_template).length
        ? safeStringArray(parsed.item_template)
        : (outlinePlan.itemTemplate.length ? outlinePlan.itemTemplate : keywordSignals.itemDetailRequirements),
      comparison_points: safeStringArray(parsed.comparison_points).length
        ? safeStringArray(parsed.comparison_points)
        : outlinePlan.comparisonPoints,
      faq_questions: safeStringArray(parsed.faq_questions).slice(0, 8).length
        ? safeStringArray(parsed.faq_questions).slice(0, 8)
        : outlinePlan.faqQuestions.slice(0, 8),
      word_count_range: String(parsed.word_count_range || blueprint.wordCountRange),
      page_goal: String(parsed.page_goal || blueprint.pageGoal),
      target_persona: String(parsed.target_persona || blueprint.persona),
      page_format: String(parsed.page_format || blueprint.pageFormat),
      meta_descriptions: safeStringArray(parsed.meta_descriptions).slice(0, 2),
      url_slug: String(parsed.url_slug || `/${keyword.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`),
      secondary_keywords: safeStringArray(parsed.secondary_keywords),
      long_tail_keywords: safeStringArray(parsed.long_tail_keywords),
      entities: safeStringArray(parsed.entities).length ? safeStringArray(parsed.entities) : serpInsights.recurringEntities,
      semantic_terms: safeStringArray(parsed.semantic_terms).length ? safeStringArray(parsed.semantic_terms) : dedupeStrings([
        ...blueprint.semanticTerms,
        ...serpInsights.recurringThemes,
        ...serpInsights.recurringAttributes,
      ], 25),
      internal_links: safeStringArray(parsed.internal_links),
      external_linking_strategy: safeStringArray(parsed.external_linking_strategy),
      media_ideas: safeStringArray(parsed.media_ideas),
      content_gaps: safeStringArray(parsed.content_gaps).length ? safeStringArray(parsed.content_gaps) : outlinePlan.opportunities,
      competitor_references: Array.isArray(parsed.competitor_references)
        ? parsed.competitor_references.map((reference: any) => ({
            title: String(reference?.title || "").trim(),
            url: String(reference?.url || "").trim(),
            why_it_matters: String(reference?.why_it_matters || "").trim(),
          })).filter((reference: any) => reference.title || reference.url)
        : searchResults.slice(0, 5).map((result) => ({
            title: result.title,
            url: result.link,
            why_it_matters: result.snippet || "Competing result from the target SERP.",
          })),
    };
  });
}

function evaluateBriefQuality(
  brief: StructuredBrief,
  keywordSignals: KeywordSignals,
  intentProfile: IntentProfile,
  serpInsights: AggregatedSerpInsights
): BriefQualityReport {
  const issues: string[] = [];
  const strengths: string[] = [];
  let score = 100;

  if (!brief.h1.trim()) {
    issues.push("Missing H1.");
    score -= 20;
  } else {
    strengths.push("H1 present.");
  }

  if (brief.sections.length < 3) {
    issues.push("Too few H2 sections.");
    score -= 20;
  } else {
    strengths.push("Multiple H2 sections present.");
  }

  const subsectionCount = brief.sections.reduce((count, section) => count + section.subsections.length, 0);
  const minimumSubsections = intentProfile.needsItemByItemCoverage
    ? Math.max(4, intentProfile.targetItemCount || keywordSignals.listCount || 6)
    : 2;
  if (subsectionCount < minimumSubsections) {
    issues.push(`Not enough H3/item-level subsections. Expected at least ${minimumSubsections}, got ${subsectionCount}.`);
    score -= 25;
  } else {
    strengths.push("Enough subsection depth for item-level coverage.");
  }

  const mustCoverCount = brief.sections.reduce((count, section) => count + section.must_cover.length, 0);
  if (mustCoverCount < Math.max(10, brief.sections.length * 3)) {
    issues.push("Writer instructions are still too thin.");
    score -= 15;
  } else {
    strengths.push("Writer guidance has reasonable depth.");
  }

  const entityHits = brief.entities.filter((entity) =>
    serpInsights.recurringEntities.some((sourceEntity) => sourceEntity.toLowerCase() === entity.toLowerCase())
  ).length;
  if (intentProfile.needsEntityLevelCoverage && entityHits < Math.min(3, serpInsights.recurringEntities.length || 3)) {
    issues.push("Brief is missing enough real entities from the SERP.");
    score -= 15;
  } else if (brief.entities.length) {
    strengths.push("Entity coverage present.");
  }

  const genericSectionMatches = brief.sections.filter((section) =>
    /how to choose|tips|common mistakes|conclusion/i.test(section.heading) &&
    intentProfile.avoidedPatterns.some((pattern) => section.heading.toLowerCase().includes(pattern.toLowerCase()))
  ).length;
  if (genericSectionMatches > 0) {
    issues.push("Brief still includes generic filler sections.");
    score -= 10;
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    issues,
    strengths,
    needsRepair: issues.length > 0,
  };
}

async function openaiRepairStructuredBrief(
  keyword: string,
  country: string | undefined,
  keywordSignals: KeywordSignals,
  intentProfile: IntentProfile,
  blueprint: BriefBlueprint,
  outlinePlan: OutlinePlan,
  serpInsights: AggregatedSerpInsights,
  entityEnrichment: EntityEnrichment,
  currentBrief: StructuredBrief,
  qualityReport: BriefQualityReport
): Promise<StructuredBrief> {
  const prompt = `Repair this content brief so it becomes deeper and more keyword-specific.

KEYWORD: ${keyword}
COUNTRY / REGION: ${country || "Not specified"}
KEYWORD SIGNALS:
${compactJson(keywordSignals)}

INTENT PROFILE:
${compactJson(intentProfile)}

BLUEPRINT:
${compactJson(blueprint)}

OUTLINE PLAN:
${compactJson(outlinePlan)}

SERP INSIGHTS:
${compactJson(serpInsights)}

ENTITY ENRICHMENT:
${compactJson(entityEnrichment)}

CURRENT BRIEF:
${compactJson(currentBrief)}

QUALITY REPORT:
${compactJson(qualityReport)}

TASK:
Return a corrected JSON brief using the exact same shape as before.

Repair goals:
- keep H1/H2/H3 structure
- deepen must_cover and research_needed
- add item-by-item subsections where missing
- replace generic sections with keyword-specific sections
- include more real entities, pricing signals, attributes, and local/tool-specific details`;

  return withRetry(async () => {
    const response = await openai.chat.completions.create({
      model: getModelName(),
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const parsed = JSON.parse(response.choices[0].message.content || "{}") as any;
    const repairedSections: DraftBriefSection[] = Array.isArray(parsed.sections)
      ? parsed.sections
          .map(normalizeDraftSection)
          .filter((section): section is DraftBriefSection => Boolean(section))
      : currentBrief.sections;
    return {
      ...currentBrief,
      ...parsed,
      title_options: safeStringArray((parsed as any).title_options).length ? safeStringArray((parsed as any).title_options) : currentBrief.title_options,
      entities: safeStringArray((parsed as any).entities).length ? safeStringArray((parsed as any).entities) : currentBrief.entities,
      semantic_terms: safeStringArray((parsed as any).semantic_terms).length ? safeStringArray((parsed as any).semantic_terms) : currentBrief.semantic_terms,
      sections: repairedSections,
    };
  });
}

export async function processSingleKeyword(
  keyword: string,
  country: string | undefined,
  rowIndex: number,
  index: number,
  total: number,
  sendEvent: SendEvent,
  sheetUrl?: string
): Promise<BriefResult> {
  const keywordSignals = deriveKeywordSignals(keyword, country);

  sendEvent({
    type: "keyword_start",
    keyword,
    message: `Processing keyword ${index + 1}/${total}: "${keyword}"${country ? ` (Region: ${country})` : ""}`,
    current: index + 1,
    total: total,
  });

  sendEvent({ type: "searching", keyword, message: `Searching Google for "${keyword}"...`, current: index + 1, total: total });
  const searchResults = await googleSearch(keyword, country);

  sendEvent({
    type: "generating",
    keyword,
    message: `Classifying search intent and brief type for "${keyword}"...`,
    current: index + 1,
    total: total,
  });
  let intentProfile: IntentProfile;
  if (FAST_MODE) {
    intentProfile = buildFallbackIntentProfile(keywordSignals);
  } else {
    try {
      intentProfile = await openaiClassifyIntent(keyword, country, keywordSignals, searchResults);
    } catch (error) {
      log(`Intent classification fallback for "${keyword}": ${error}`, "workflow");
      await delay(LOAD_BACKOFF_MS);
      intentProfile = buildFallbackIntentProfile(keywordSignals);
    }
  }

  sendEvent({ type: "filtering", keyword, message: `Filtering search results for "${keyword}"...`, current: index + 1, total: total });
  const { filtered_results } = filterSearchResults(searchResults, keyword);

  sendEvent({ type: "filtering", keyword, message: `Selecting the best competitor URLs for "${keyword}"...`, current: index + 1, total: total });
  let topUrls: SearchResult[];
  try {
    topUrls = FAST_MODE
      ? filtered_results.slice(0, MAX_COMPETITOR_URLS)
      : await openaiFilterTopUrls(filtered_results, keyword);
  } catch (error) {
    log(`URL selection fallback for "${keyword}": ${error}`, "workflow");
    topUrls = filtered_results.slice(0, MAX_COMPETITOR_URLS);
  }

  const limit = pLimit(2);
  const insightPromises = topUrls.map((url, j) =>
    limit(async () => {
      sendEvent({
        type: "scraping",
        keyword,
        message: `Processing competitor page ${j + 1}/${topUrls.length}...`,
        current: index + 1,
        total: total,
      });

      const content = await scrapeWebsite(url.link);

      sendEvent({
        type: "summarizing",
        keyword,
        message: `Extracting structured SERP insights from competitor page ${j + 1}/${topUrls.length}...`,
        current: index + 1,
        total: total,
      });

      if (FAST_MODE) {
        const heuristic = extractHeuristicInsightFromContent(content, url.link);
        if (country) heuristic.locale_signals = [country];
        return heuristic;
      }
      try {
        return await openaiExtractCompetitorInsight(content, url.link, keyword, country, intentProfile);
      } catch (error) {
        log(`Competitor insight fallback for "${keyword}" on ${url.link}: ${error}`, "workflow");
        return {
          source_url: url.link,
          page_title: url.title || url.link,
          content_format: "article",
          estimated_word_count: 0,
          headings: [],
          common_themes: [],
          unique_angles: [],
          notable_features: [],
          named_entities: [],
          factual_attributes: [],
          locale_signals: country ? [country] : [],
          item_candidates: [],
          faq_candidates: [],
          pricing_mentions: [],
          comparison_dimensions: [],
        } satisfies CompetitorInsight;
      }
    })
  );

  const insightResults = await Promise.all(insightPromises);
  const insights = insightResults.filter(Boolean) as CompetitorInsight[];
  const serpInsights = aggregateCompetitorInsights(insights);
  const entityEnrichment = buildEntityEnrichment(keywordSignals, intentProfile, serpInsights);

  sendEvent({
    type: "generating",
    keyword,
    message: `Building keyword-specific brief blueprint for "${keyword}"...`,
    current: index + 1,
    total: total,
  });

  let blueprint: BriefBlueprint;
  if (FAST_MODE) {
    blueprint = buildFallbackBlueprint(keyword, country, keywordSignals, intentProfile, serpInsights);
  } else {
    try {
      blueprint = await openaiBuildBriefBlueprint(
        keyword,
        country,
        keywordSignals,
        intentProfile,
        topUrls,
        serpInsights
      );
    } catch (error) {
      log(`Blueprint fallback for "${keyword}": ${error}`, "workflow");
      await delay(LOAD_BACKOFF_MS);
      blueprint = buildFallbackBlueprint(keyword, country, keywordSignals, intentProfile, serpInsights);
    }
  }

  sendEvent({
    type: "generating",
    keyword,
    message: `Planning H1/H2/H3 outline and writer coverage for "${keyword}"...`,
    current: index + 1,
    total: total,
  });
  let outlinePlan: OutlinePlan;
  if (FAST_MODE) {
    outlinePlan = buildFallbackOutlinePlan(keyword, keywordSignals, blueprint, entityEnrichment);
  } else {
    try {
      outlinePlan = await openaiBuildOutlinePlan(
        keyword,
        country,
        keywordSignals,
        intentProfile,
        blueprint,
        serpInsights,
        entityEnrichment
      );
    } catch (error) {
      log(`Outline fallback for "${keyword}": ${error}`, "workflow");
      await delay(LOAD_BACKOFF_MS);
      outlinePlan = buildFallbackOutlinePlan(keyword, keywordSignals, blueprint, entityEnrichment);
    }
  }

  sendEvent({
    type: "generating",
    keyword,
    message: `Generating content brief for "${keyword}"...`,
    current: index + 1,
    total: total,
  });

  let structuredBrief: StructuredBrief;
  try {
    structuredBrief = await openaiGenerateStructuredBrief(
      keyword,
      country,
      keywordSignals,
      intentProfile,
      blueprint,
      outlinePlan,
      topUrls,
      serpInsights,
      entityEnrichment
    );
  } catch (error) {
    log(`Brief generation fallback for "${keyword}": ${error}`, "workflow");
    await delay(LOAD_BACKOFF_MS);
    structuredBrief = buildFallbackStructuredBrief(
      keyword,
      country,
      blueprint,
      outlinePlan,
      serpInsights,
      topUrls,
      keywordSignals
    );
  }
  const qualityReport = evaluateBriefQuality(structuredBrief, keywordSignals, intentProfile, serpInsights);
  if (!FAST_MODE && qualityReport.needsRepair) {
    sendEvent({
      type: "generating",
      keyword,
      message: `Improving brief depth and specificity for "${keyword}"...`,
      current: index + 1,
      total: total,
    });
    try {
      structuredBrief = await openaiRepairStructuredBrief(
        keyword,
        country,
        keywordSignals,
        intentProfile,
        blueprint,
        outlinePlan,
        serpInsights,
        entityEnrichment,
        structuredBrief,
        qualityReport
      );
    } catch (error) {
      log(`Repair fallback for "${keyword}": ${error}`, "workflow");
      await delay(LOAD_BACKOFF_MS);
    }
  }
  let generatedContent = renderStructuredBrief(keyword, country, structuredBrief);
  if (CONTENT_OUTPUT_MODE === "article") {
    sendEvent({
      type: "generating",
      keyword,
      message: `Writing full article draft for "${keyword}"...`,
      current: index + 1,
      total: total,
    });
    try {
      const draft = await openaiGenerateArticleDraft(
        keyword,
        country,
        structuredBrief,
        keywordSignals,
        entityEnrichment,
        serpInsights,
        topUrls
      );
      generatedContent = draft
        ? sanitizeGeneratedArticle(convertMarkdownHeadingsToOutlineLabels(draft))
        : sanitizeGeneratedArticle(buildFallbackArticleDraft(keyword, country, structuredBrief));
      const minimumWords = keywordSignals.primarySubject === "tools" || keywordSignals.listCount ? 1400 : 1100;
      if (countWords(generatedContent) < minimumWords) {
        try {
          const expandedDraft = await openaiExpandArticleDraft(
            keyword,
            country,
            generatedContent,
            structuredBrief,
            keywordSignals
          );
          if (expandedDraft.trim()) {
            generatedContent = sanitizeGeneratedArticle(convertMarkdownHeadingsToOutlineLabels(expandedDraft));
          }
        } catch (error) {
          log(`Article expansion fallback for "${keyword}": ${error}`, "workflow");
        }
      }
    } catch (error) {
      log(`Article draft fallback for "${keyword}": ${error}`, "workflow");
      generatedContent = sanitizeGeneratedArticle(buildFallbackArticleDraft(keyword, country, structuredBrief));
    }
  }
  const timestamp = new Date().toISOString();
  const finalBrief = `${generatedContent}\n\n---\nGenerated: ${timestamp}\n`;

  let googleDocUrl: string | undefined;
  if (ENABLE_GOOGLE_DOC) {
    try {
      sendEvent({ type: "generating", keyword, message: "Creating Google Doc...", current: index + 1, total: total });
      googleDocUrl = await createGoogleDoc(keyword, finalBrief);
      
      if (sheetUrl) {
        await writeBackToSheet(sheetUrl, rowIndex, googleDocUrl);
      }
    } catch (error) {
      log(`Warning: Google Doc creation or write back failed: ${error}`, "workflow");
    }
  }

  sendEvent({
    type: "keyword_complete",
    keyword,
    message: `Completed brief for "${keyword}"`,
    current: index + 1,
    total: total,
  });

  log(`Brief generated for keyword: ${keyword}`, "workflow");

  return {
    keyword,
    country,
    brief_content: finalBrief,
    timestamp,
    google_doc_url: googleDocUrl,
    structured_brief: structuredBrief,
  };
}

export async function processWorkflow(
  sheetUrl: string,
  sendEvent: SendEvent
): Promise<BriefResult[]> {
  sendEvent({ type: "started", message: "Fetching keywords from Google Sheet..." });

  const items = await fetchKeywordsFromSheet(sheetUrl);
  sendEvent({
    type: "started",
    message: `Found ${items.length} keyword(s) to process`,
    total: items.length,
  });

  const allBriefs: BriefResult[] = [];

  for (let i = 0; i < items.length; i++) {
    const { keyword, country, rowIndex } = items[i];
    try {
      const brief = await processSingleKeyword(keyword, country, rowIndex, i, items.length, sendEvent, sheetUrl);
      allBriefs.push(brief);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      log(`Error processing keyword "${keyword}": ${errorMessage}`, "workflow");
      sendEvent({
        type: "error",
        keyword: keyword,
        message: `Error processing "${keyword}": ${errorMessage}`,
        current: i + 1,
        total: items.length,
      });
    }

    if (i < items.length - 1 && KEYWORD_COOLDOWN_MS > 0) {
      sendEvent({
        type: "generating",
        message: `Cooling down before the next keyword...`,
        current: i + 1,
        total: items.length,
      });
      await delay(KEYWORD_COOLDOWN_MS);
    }
  }

  sendEvent({
    type: "complete",
    message: `Completed! Generated ${allBriefs.length} brief(s)`,
    current: items.length,
    total: items.length,
  });

  return allBriefs;
}
