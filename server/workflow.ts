import { GoogleGenerativeAI } from "@google/generative-ai";
import type { BriefResult, ProgressEvent } from "../shared/schema.js";
import pLimit from "p-limit";

import { log } from "./index.js";


// Lazy initialization of Gemini instances to ensure environment variables are loaded
const getAI_Filter = () => new GoogleGenerativeAI(process.env.GEMINI_API_KEY_FILTER || "");
const getAI_Summarize = () => new GoogleGenerativeAI(process.env.GEMINI_API_KEY_SUMMARIZE || "");
const getAI_Brief = () => new GoogleGenerativeAI(process.env.GEMINI_API_KEY_BRIEF || "");

const getModelName = () => process.env.GEMINI_MODEL || "gemini-1.5-flash";

const SERPER_API_KEY = () => process.env.SERPER_API_KEY || "";


type SendEvent = (event: ProgressEvent) => void;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 10, waitMs = 20000): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      if (attempt === maxRetries) throw error;

      const errorMessage = error instanceof Error ? error.message : String(error);
      let backoff = waitMs;

      // Smart Retry: Detect Gemini 429 Quota errors and parse retryDelay
      if (errorMessage.includes("429") || errorMessage.includes("Quota exceeded")) {
        log(`Quota hit on attempt ${attempt}. Searching for retry delay...`, "workflow");
        
        // Try to find "retryDelay": "Xs" in the error message (provided by Google Cloud API)
        const delayMatch = errorMessage.match(/"retryDelay":\s*"(\d+)s"/);
        if (delayMatch && delayMatch[1]) {
          const seconds = parseInt(delayMatch[1], 10);
          backoff = (seconds + 2) * 1000; // Add 2 seconds buffer
          log(`Found explicit retry delay: ${seconds}s. Waiting ${backoff / 1000}s...`, "workflow");
        } else {
          // Default to a longer wait for quota issues if no explicit delay found
          backoff = Math.max(waitMs, 60000); 
          log(`No explicit delay found for 429. Waiting 60s default...`, "workflow");
        }
      } else {
        log(`Retry ${attempt}/${maxRetries} after error: ${errorMessage}`, "workflow");
      }

      await delay(backoff);
    }
  }
  throw new Error("Exhausted retries after 10 attempts");
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

export async function fetchKeywordsFromSheet(sheetUrl: string): Promise<string[]> {
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

  if (keywordIndex === -1) {
    throw new Error('Sheet must have a column named "keyword"');
  }

  const keywords = lines.slice(1)
    .map((line) => {
      const cols = parseCSVLine(line);
      return (cols[keywordIndex] || "").replace(/^["']|["']$/g, "").trim();
    })
    .filter((k) => k.length > 0);

  if (keywords.length === 0) {
    throw new Error("No keywords found in the sheet");
  }

  return keywords;
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

async function googleSearch(keyword: string): Promise<SearchResult[]> {
  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": SERPER_API_KEY(),
    },
    body: JSON.stringify({ q: keyword, num: 10 }),
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
    if (cleanResults.length >= 3) break;
  }
  return { filtered_results: cleanResults, keyword };
}

async function geminiFilterTopUrls(filteredResults: SearchResult[], keyword: string): Promise<SearchResult[]> {
  const promptText = `SEARCH RESULTS:

${JSON.stringify(filteredResults, null, 2)}

KEYWORD: ${keyword}

TASK: From the search results above, select the best 3 URLs (maximum 6 if highly relevant) that would provide the most comprehensive information for creating a content brief about '${keyword}'.

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
    const model = getAI_Filter().getGenerativeModel({ model: getModelName() });
    const result = await model.generateContent(promptText);
    const response = await result.response;
    let contentText = response.text();

    contentText = contentText.replace(/```json/g, "").replace(/```/g, "").trim();

    const start = contentText.indexOf("[");
    const end = contentText.lastIndexOf("]");
    if (start === -1 || end === -1) return filteredResults;

    try {
      return JSON.parse(contentText.substring(start, end + 1));
    } catch {
      return filteredResults;
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

async function geminiSummarizeContent(content: string, sourceUrl: string, keyword: string): Promise<string> {
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
    await delay(6000);
    const model = getAI_Summarize().getGenerativeModel({ model: getModelName() });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text();
  });
}

async function geminiGenerateBrief(keyword: string, competitorAnalysis: string): Promise<string> {
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
- Examples: [reference examples from competing pages]
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

===================================
INTERNAL LINKING SUGGESTIONS
===================================
- [Suggested internal link 1]
- [Suggested internal link 2]
- [Suggested internal link 3]

===================================
CONTENT DIFFERENTIATION
===================================
Based on competitor analysis, here's how to make this content stand out:
- [Unique angle 1]
- [Unique angle 2]
- [Unique angle 3]

Make the brief actionable, specific, and based on the actual competitor analysis provided. Every recommendation should be supported by evidence from the competing pages.`;

  return withRetry(async () => {
    await delay(10000);
    const model = getAI_Brief().getGenerativeModel({ model: getModelName() });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text();
  });
}

export async function processSingleKeyword(
  keyword: string,
  index: number,
  total: number,
  sendEvent: SendEvent
): Promise<BriefResult> {
  sendEvent({
    type: "keyword_start",
    keyword,
    message: `Processing keyword ${index + 1}/${total}: "${keyword}"`,
    current: index + 1,
    total: total,
  });

  sendEvent({ type: "searching", keyword, message: `Searching Google for "${keyword}"...`, current: index + 1, total: total });
  const searchResults = await googleSearch(keyword);

  sendEvent({ type: "filtering", keyword, message: `Filtering search results for "${keyword}"...`, current: index + 1, total: total });
  const { filtered_results } = filterSearchResults(searchResults, keyword);

  sendEvent({ type: "filtering", keyword, message: `Using AI to select best URLs for "${keyword}"...`, current: index + 1, total: total });
  const topUrls = await geminiFilterTopUrls(filtered_results, keyword);

  // Parallelize scraping and summarizing within a single keyword
  // We use p-limit(1) to stay under Gemini's Free Tier RPM limits
  const limit = pLimit(1);
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

      return geminiSummarizeContent(content, url.link, keyword);
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

  const briefContent = await geminiGenerateBrief(keyword, combinedAnalysis);
  const timestamp = new Date().toISOString();
  const finalBrief = `${briefContent}\n\n---\nGenerated: ${timestamp}\n`;

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
    brief_content: finalBrief,
    timestamp,
  };
}

export async function processWorkflow(
  sheetUrl: string,
  sendEvent: SendEvent
): Promise<BriefResult[]> {
  sendEvent({ type: "started", message: "Fetching keywords from Google Sheet..." });

  const keywords = await fetchKeywordsFromSheet(sheetUrl);
  sendEvent({
    type: "started",
    message: `Found ${keywords.length} keyword(s) to process`,
    total: keywords.length,
  });

  const allBriefs: BriefResult[] = [];

  // Keep compatibility for now, but in a real-world scenario we'd use processSingleKeyword
  for (let i = 0; i < keywords.length; i++) {
    try {
      const brief = await processSingleKeyword(keywords[i], i, keywords.length, sendEvent);
      allBriefs.push(brief);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      log(`Error processing keyword "${keywords[i]}": ${errorMessage}`, "workflow");
      sendEvent({
        type: "error",
        keyword: keywords[i],
        message: `Error processing "${keywords[i]}": ${errorMessage}`,
        current: i + 1,
        total: keywords.length,
      });
    }
  }

  sendEvent({
    type: "complete",
    message: `Completed! Generated ${allBriefs.length} brief(s)`,
    current: keywords.length,
    total: keywords.length,
  });

  return allBriefs;
}

