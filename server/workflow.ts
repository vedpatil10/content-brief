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

function safeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function renderBullets(items: string[], emptyText = "None specified"): string {
  if (!items.length) return `- ${emptyText}`;
  return items.map((item) => `- ${item}`).join("\n");
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
BRIEF SNAPSHOT
===================================
Search Intent: ${brief.search_intent}
Recommended Angle: ${brief.search_angle}
Article Type: ${brief.article_type}
Page Goal: ${brief.page_goal}
Target Persona: ${brief.target_persona}
Word Count Range: ${brief.word_count_range}
Page Format: ${brief.page_format}

Summary:
${brief.brief_summary}

===================================
PAGE TITLE OPTIONS
===================================
${brief.title_options.map((title, index) => `${index + 1}. ${title}`).join("\n")}

===================================
OUTLINE & WRITER INSTRUCTIONS
===================================
H1: ${brief.h1}

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
TECHNICAL SEO ELEMENTS
===================================
Meta Description Options:
${brief.meta_descriptions.map((description, index) => `${index + 1}. ${description}`).join("\n")}

URL Structure: ${brief.url_slug}

Keyword Clusters:
- Primary: ${keyword}
- Secondary: ${brief.secondary_keywords.join(", ") || "None specified"}
- Long-tail: ${brief.long_tail_keywords.join(", ") || "None specified"}

Entity Recommendations:
${renderBullets(brief.entities)}

Semantic Search Terms:
${renderBullets(brief.semantic_terms)}

Internal Links:
${renderBullets(brief.internal_links)}

External Linking Strategy:
${renderBullets(brief.external_linking_strategy)}

Media Ideas:
${renderBullets(brief.media_ideas)}

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

Return ONLY a JSON array with this exact structure:
[
  {"title": "...", "link": "...", "snippet": "..."},
  {"title": "...", "link": "...", "snippet": "..."}
]

No other text or explanation. Just the JSON array.`;

  return withRetry(async () => {
    const response = await openai.chat.completions.create({
      model: getModelName(),
      messages: [{ role: "user", content: promptText }],
      response_format: { type: "json_object" },
    });

    let contentText = response.choices[0].message.content || "[]";
    
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
      `BODY:\n${text.substring(0, 14000)}`,
    ].filter(Boolean).join("\n\n");
  } catch {
    return "Content not available";
  }
}

async function openaiSummarizeContent(content: string, sourceUrl: string, keyword: string, country?: string): Promise<string> {
  const prompt = `WEBPAGE CONTENT:

${content}

SOURCE URL: ${sourceUrl}

KEYWORD: ${keyword}
COUNTRY / REGION: ${country || "Not specified"}

TASK: Analyze this webpage and extract:
1. Main heading structure (H1, H2, H3)
2. Key topics covered
3. Word count estimate
4. Unique angles or approaches
5. Content format (guide, listicle, article, etc.)
6. Notable features (FAQs, tables, examples, etc.)
7. Named entities, places, brands, products, or venues explicitly mentioned
8. Specific factual attributes that a writer would need to include to satisfy search intent
9. How localized the page is and whether it reflects the target geography

Focus ONLY on content relevant to '${keyword}'. Strip away navigation, ads, footers.

Provide detailed summary with source URL at the end:
Source: ${sourceUrl}`;

  return withRetry(async () => {
    const response = await openai.chat.completions.create({
      model: getModelName(),
      messages: [{ role: "user", content: prompt }],
    });
    return response.choices[0].message.content || "";
  });
}

async function openaiBuildBriefBlueprint(
  keyword: string,
  country: string | undefined,
  keywordSignals: KeywordSignals,
  searchResults: SearchResult[],
  competitorAnalysis: string
): Promise<BriefBlueprint> {
  const prompt = `You are an expert SEO strategist building a structured content brief plan.

KEYWORD: ${keyword}
COUNTRY / REGION: ${country || "Not specified"}
LOCAL KEYWORD SIGNALS:
${JSON.stringify(keywordSignals, null, 2)}

TOP SERP RESULTS:
${formatSearchResults(searchResults)}

COMPETITOR ANALYSIS:
${competitorAnalysis}

TASK:
Return a JSON object that adapts the brief to the keyword's real intent and locale. Do not create a generic template.

Rules:
- If the keyword is a local list query, the outline must center on ranked entities, selection criteria, neighborhoods/areas, pricing, standout features, and booking/visit guidance.
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

async function openaiGenerateStructuredBrief(
  keyword: string,
  country: string | undefined,
  keywordSignals: KeywordSignals,
  blueprint: BriefBlueprint,
  searchResults: SearchResult[],
  competitorAnalysis: string
): Promise<StructuredBrief> {
  const prompt = `You are Britta, an expert content strategist AI that creates detailed content briefs.

KEYWORD: ${keyword}
COUNTRY / REGION: ${country || "Not specified"}
KEYWORD SIGNALS:
${JSON.stringify(keywordSignals, null, 2)}

BRIEF BLUEPRINT:
${JSON.stringify(blueprint, null, 2)}

TOP SERP RESULTS:
${formatSearchResults(searchResults)}

COMPETITOR ANALYSIS:
${competitorAnalysis}

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
    const defaultToolSections = keywordSignals.primarySubject === "tools" ? [
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
        subsections: (blueprint.recommendedH2s[0]?.h3s || []).slice(0, keywordSignals.listCount || 8).map((heading) => ({
          heading,
          purpose: "Break down one tool in depth.",
          must_cover: keywordSignals.itemDetailRequirements,
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
    const fallbackSections = blueprint.recommendedH2s.map((section) => ({
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
    }));

    return {
      search_intent: parsed.search_intent || blueprint.inferredIntent,
      search_angle: parsed.search_angle || blueprint.searchAngle,
      article_type: parsed.article_type || blueprint.articleFormat,
      brief_summary: parsed.brief_summary || `Create a more detailed, intent-matched article for ${keyword}.`,
      title_options: safeStringArray(parsed.title_options).slice(0, 3).length
        ? safeStringArray(parsed.title_options).slice(0, 3)
        : blueprint.suggestedTitleAngles.slice(0, 3),
      h1: parsed.h1 || keyword,
      sections: Array.isArray(parsed.sections) ? parsed.sections.map((section: any) => ({
        level: section?.level === "H3" ? "H3" : "H2",
        heading: String(section?.heading || "").trim(),
        purpose: String(section?.purpose || "").trim(),
        section_type: String(section?.section_type || "core").trim(),
        must_cover: safeStringArray(section?.must_cover),
        research_needed: safeStringArray(section?.research_needed),
        differentiation: safeStringArray(section?.differentiation),
        examples: safeStringArray(section?.examples),
        watch_out_for: safeStringArray(section?.watch_out_for),
        subsections: Array.isArray(section?.subsections) ? section.subsections.map((subsection: any) => ({
          heading: String(subsection?.heading || "").trim(),
          purpose: String(subsection?.purpose || "").trim(),
          must_cover: safeStringArray(subsection?.must_cover),
        })).filter((subsection: any) => subsection.heading) : [],
      })).filter((section: any) => section.heading) : (defaultToolSections.length ? defaultToolSections : fallbackSections),
      item_template: safeStringArray(parsed.item_template).length
        ? safeStringArray(parsed.item_template)
        : keywordSignals.itemDetailRequirements,
      comparison_points: safeStringArray(parsed.comparison_points),
      faq_questions: safeStringArray(parsed.faq_questions).slice(0, 8),
      word_count_range: String(parsed.word_count_range || blueprint.wordCountRange),
      page_goal: String(parsed.page_goal || blueprint.pageGoal),
      target_persona: String(parsed.target_persona || blueprint.persona),
      page_format: String(parsed.page_format || blueprint.pageFormat),
      meta_descriptions: safeStringArray(parsed.meta_descriptions).slice(0, 2),
      url_slug: String(parsed.url_slug || `/${keyword.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`),
      secondary_keywords: safeStringArray(parsed.secondary_keywords),
      long_tail_keywords: safeStringArray(parsed.long_tail_keywords),
      entities: safeStringArray(parsed.entities),
      semantic_terms: safeStringArray(parsed.semantic_terms),
      internal_links: safeStringArray(parsed.internal_links),
      external_linking_strategy: safeStringArray(parsed.external_linking_strategy),
      media_ideas: safeStringArray(parsed.media_ideas),
      content_gaps: safeStringArray(parsed.content_gaps),
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

  sendEvent({ type: "filtering", keyword, message: `Filtering search results for "${keyword}"...`, current: index + 1, total: total });
  const { filtered_results } = filterSearchResults(searchResults, keyword);

  sendEvent({ type: "filtering", keyword, message: `Selecting the best competitor URLs for "${keyword}"...`, current: index + 1, total: total });
  const topUrls = await openaiFilterTopUrls(filtered_results, keyword);

  const limit = pLimit(2);
  const summaryPromises = topUrls.map((url, j) =>
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
        message: `Analyzing content from competitor page ${j + 1}/${topUrls.length}...`,
        current: index + 1,
        total: total,
      });

      return openaiSummarizeContent(content, url.link, keyword, country);
    })
  );

  const summariesResult = await Promise.all(summaryPromises);
  const summaries = summariesResult.filter(Boolean) as string[];

  const combinedAnalysis = summaries.join("\n\n---\n\n");

  sendEvent({
    type: "generating",
    keyword,
    message: `Building keyword-specific brief logic for "${keyword}"...`,
    current: index + 1,
    total: total,
  });

  const blueprint = await openaiBuildBriefBlueprint(
    keyword,
    country,
    keywordSignals,
    topUrls,
    combinedAnalysis
  );

  sendEvent({
    type: "generating",
    keyword,
    message: `Generating content brief for "${keyword}"...`,
    current: index + 1,
    total: total,
  });

  const structuredBrief = await openaiGenerateStructuredBrief(
    keyword,
    country,
    keywordSignals,
    blueprint,
    topUrls,
    combinedAnalysis
  );
  const briefContent = renderStructuredBrief(keyword, country, structuredBrief);
  const timestamp = new Date().toISOString();
  const finalBrief = `${briefContent}\n\n---\nGenerated: ${timestamp}\n`;

  let googleDocUrl: string | undefined;
  try {
    sendEvent({ type: "generating", keyword, message: "Creating Google Doc...", current: index + 1, total: total });
    googleDocUrl = await createGoogleDoc(keyword, finalBrief);
    
    if (sheetUrl) {
      await writeBackToSheet(sheetUrl, rowIndex, googleDocUrl);
    }
  } catch (error) {
    log(`Warning: Google Doc creation or write back failed: ${error}`, "workflow");
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
  }

  sendEvent({
    type: "complete",
    message: `Completed! Generated ${allBriefs.length} brief(s)`,
    current: items.length,
    total: items.length,
  });

  return allBriefs;
}
