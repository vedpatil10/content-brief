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

async function googleSearch(keyword: string, country?: string): Promise<SearchResult[]> {
  const body: any = { q: keyword, num: 10 };
  
  if (country) {
    const countryMap: Record<string, string> = {
      'australia': 'au', 'au': 'au',
      'united states': 'us', 'usa': 'us', 'us': 'us',
      'india': 'in', 'in': 'in',
      'canada': 'ca', 'ca': 'ca',
      'united kingdom': 'uk', 'uk': 'uk', 'gb': 'uk', 'great britain': 'uk',
      'new zealand': 'nz', 'nz': 'nz',
      'south africa': 'za', 'za': 'za'
    };
    const gl = countryMap[country.toLowerCase()] || country.toLowerCase();
    body.gl = gl;
    log(`Searching with country code (gl): ${gl}`, "workflow");
  }

  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": SERPER_API_KEY(),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Serper API error: ${response.status}`);
  }

  const data = await response.json();
  return (data.organic || []) as SearchResult[];
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
      return Array.isArray(urls) ? urls.slice(0, 5) : [];
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

    return text.substring(0, 15000);
  } catch {
    return "Content not available";
  }
}

async function openaiSummarizeContent(content: string, sourceUrl: string, keyword: string): Promise<string> {
  const prompt = `WEBPAGE CONTENT:

${content}

SOURCE URL: ${sourceUrl}

KEYWORD: ${keyword}

TASK: Analyze this webpage and extract:
1. Main heading structure (H1, H2, H3)
2. Key topics covered
3. Word count estimate
4. Unique angles or approaches
5. Content format (guide, listicle, article, etc.)
6. Notable features (FAQs, tables, examples, etc.)

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

async function openaiGenerateBrief(keyword: string, competitorAnalysis: string): Promise<string> {
  const prompt = `You are Britta, an expert content strategist AI that creates detailed content briefs.

KEYWORD: ${keyword}

COMPETITOR ANALYSIS:
${competitorAnalysis}

TASK: Create a comprehensive content brief following this exact structure:

CONTENT BRIEF: ${keyword}

===================================
PAGE TITLE OPTIONS
===================================
Analyze shared keywords across competing pages and provide 3 title options:
1. [Title 1]
2. [Title 2]
3. [Title 3]

===================================
HEADING STRUCTURE
===================================
H1: [Main heading]

H2: [Section 1]
Writer Notes:
- Key points: [list main points to cover based on competitor analysis]
- Research needed: [specific research requirements]
- Style guide: [tone and approach recommendations]
- Examples: [reference specific examples and links from the competing pages provided in the analysis]
- Watch out for: [common pitfalls observed]

  H3: [Subsection 1.1]
  H3: [Subsection 1.2]

[Continue with 5-6 H2 sections total, each with writer notes]

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

Generate the complete brief based STRICTLY on the competitor analysis provided. Be specific and actionable.`;

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

  sendEvent({ type: "filtering", keyword, message: `Using AI to select best URLs for "${keyword}"...`, current: index + 1, total: total });
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

      return openaiSummarizeContent(content, url.link, keyword);
    })
  );

  const summariesResult = await Promise.all(summaryPromises);
  const summaries = summariesResult.filter(Boolean) as string[];

  const combinedAnalysis = summaries.join("\n\n---\n\n");

  sendEvent({
    type: "generating",
    keyword,
    message: `Generating content brief for "${keyword}"...`,
    current: index + 1,
    total: total,
  });

  const briefContent = await openaiGenerateBrief(keyword, combinedAnalysis);
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
