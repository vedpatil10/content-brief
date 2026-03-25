import OpenAI from "openai";
import type { BriefResult, ProgressEvent } from "../shared/schema.js";
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
  modifierTerms: string[];
  localeHints: string[];
  requiresLocalSpecifics: boolean;
  dataPoints: string[];
  sectionPatterns: string[];
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

  let keywordType = "informational";
  let articleFormat = "guide";
  let inferredIntent = "informational";
  let dataPoints = ["search intent alignment", "key subtopics", "common competitor sections"];
  let sectionPatterns = ["overview", "main topic coverage", "supporting FAQs"];

  if (isComparison) {
    keywordType = "comparison";
    articleFormat = "comparison page";
    inferredIntent = "commercial investigation";
    dataPoints = ["comparison criteria", "feature differences", "pricing", "best-fit use cases", "pros and cons"];
    sectionPatterns = ["comparison table", "head-to-head criteria", "best for X"];
  } else if (isListicle && isLocal && isHospitality) {
    keywordType = "localized ranked list";
    articleFormat = "ranked local listicle";
    inferredIntent = "local commercial investigation";
    dataPoints = ["ranked entities", "neighborhood/location", "price range", "signature offering", "amenities", "booking details", "why it stands out"];
    sectionPatterns = ["ranked list", "selection methodology", "map/area guidance", "booking tips"];
  } else if (isListicle) {
    keywordType = "ranked list";
    articleFormat = "listicle";
    inferredIntent = isCommercial ? "commercial investigation" : "informational";
    dataPoints = ["ranked items", "selection criteria", "use cases", "pricing or accessibility", "pros and cons"];
    sectionPatterns = ["ranked picks", "how we chose", "best for segments"];
  } else if (isHowTo) {
    keywordType = "how-to";
    articleFormat = "step-by-step guide";
    inferredIntent = "informational";
    dataPoints = ["process steps", "requirements", "mistakes to avoid", "examples"];
    sectionPatterns = ["steps", "requirements", "examples", "FAQ"];
  } else if (isCommercial) {
    keywordType = "commercial page";
    articleFormat = "buyer guide";
    inferredIntent = "commercial investigation";
    dataPoints = ["features", "pricing", "fit by audience", "alternatives", "selection criteria"];
    sectionPatterns = ["features", "pricing", "buyer advice", "alternatives"];
  }

  return {
    keywordType,
    inferredIntent,
    articleFormat,
    listCount,
    modifierTerms,
    localeHints,
    requiresLocalSpecifics: isLocal || isHospitality,
    dataPoints,
    sectionPatterns,
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

async function openaiGenerateBrief(
  keyword: string,
  country: string | undefined,
  keywordSignals: KeywordSignals,
  blueprint: BriefBlueprint,
  searchResults: SearchResult[],
  competitorAnalysis: string
): Promise<string> {
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

TASK: Create a comprehensive content brief following this exact structure:

CONTENT BRIEF: ${keyword}

===================================
PAGE TITLE OPTIONS
===================================
Use the blueprint and SERP analysis to provide 3 title options:
1. [Title 1]
2. [Title 2]
3. [Title 3]

===================================
HEADING STRUCTURE
===================================
H1: [Main heading]

H2: [Section 1]
Writer Notes:
- Key points: [list main points to cover based on intent, locale, and competitor analysis]
- Research needed: [specific factual data the writer must collect]
- Style guide: [tone and approach recommendations]
- Examples: [reference specific examples, entities, and links from the competing pages]
- Watch out for: [common pitfalls observed]

  H3: [Subsection 1.1]
  H3: [Subsection 1.2]

[Continue with the H2/H3 structure that best fits the keyword. Do not force generic sections.]

===================================
FAQS
===================================
1. [Question 1]
2. [Question 2]
3. [Question 3]
4. [Question 4]
5. [Question 5]
6. [Question 6]

===================================
CONTENT SPECIFICATIONS
===================================
Word Count Range: [X - Y words based on competitor analysis]
Page Goal: [Primary objective]
Target Persona: [Audience description]
Page Format: [Recommended format]

===================================
TECHNICAL SEO ELEMENTS
===================================
Meta Description Options:
1. [Meta description 1]
2. [Meta description 2]

URL Structure: [recommended URL format]

Keyword Clusters:
- Primary: ${keyword}
- Secondary: [related keywords from analysis]
- Long-tail: [long-tail variations]

Entity Recommendations:
- [entity 1]
- [entity 2]
- [entity 3]

Semantic Search Terms:
- [term 1]
- [term 2]
- [term 3]

===================================
CONTENT ENHANCEMENT IDEAS
===================================
Lists/Tables:
- [suggestion 1]
- [suggestion 2]

EEAT Incorporation:
- [EEAT element 1]
- [EEAT element 2]

CTA Recommendations:
- [CTA placement and messaging]

External Linking Strategy:
- [linking recommendations]

Media Placement:
- [media suggestions]

===================================
OPPORTUNITIES & GAPS
===================================
[List content gaps found in competitor analysis]

===================================
END OF BRIEF
===================================

Critical rules:
- The heading structure must be customized to the keyword. Do not reuse generic sections like "How to choose" or "Common use cases" unless the SERP clearly supports them.
- If the keyword implies a list of real places, products, or services, the brief must tell the writer to include actual named entities and the factual attributes needed for each entry.
- If the keyword is localized, explicitly reflect the target geography and local search expectations.
- Only ask for menu items or signature dishes when the topic is food/hospitality related.
- Keep the brief actionable for SurferSEO-style content scoring by using specific entities, semantically related terms, and intent-aligned subsections.

Generate the complete brief based STRICTLY on the blueprint, SERP results, and competitor analysis provided. Be specific and actionable.`;

  return withRetry(async () => {
    const response = await openai.chat.completions.create({
      model: getModelName(),
      messages: [{ role: "user", content: prompt }],
    });
    return response.choices[0].message.content || "";
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

  const briefContent = await openaiGenerateBrief(
    keyword,
    country,
    keywordSignals,
    blueprint,
    topUrls,
    combinedAnalysis
  );
  const timestamp = new Date().toISOString();
  const finalBrief = `${briefContent}\n\n---\nGenerated: ${timestamp}\n`;

  let googleDocUrl: string | undefined;
  /* 
  // Temporarily disabled per user request
  try {
    sendEvent({ type: "generating", keyword, message: "Creating Google Doc...", current: index + 1, total: total });
    googleDocUrl = await createGoogleDoc(keyword, finalBrief);
    
    if (sheetUrl) {
      await writeBackToSheet(sheetUrl, rowIndex, googleDocUrl);
    }
  } catch (error) {
    log(`Warning: Google Doc creation or write back failed: ${error}`, "workflow");
  }
  */

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
