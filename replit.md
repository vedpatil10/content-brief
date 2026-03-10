# SEO Content Brief Generator

## Overview
An AI-powered SEO content brief generator that replicates the n8n "Bulk Brief Tool Workflow V2" as a web application. Users paste a Google Sheet URL containing keywords, and the app generates comprehensive content briefs using Google Search (Serper API) and Gemini AI.

## Architecture
- **Frontend**: React + TypeScript with Vite, Tailwind CSS, shadcn/ui
- **Backend**: Express.js with Server-Sent Events (SSE) for real-time progress
- **AI**: Gemini 2.5 Flash via Replit AI Integrations (no API key needed)
- **Search**: Serper API for Google SERP data
- **Output**: ExcelJS for .xlsx file generation

## Workflow Pipeline (per keyword)
1. Fetch Google Sheet as CSV → parse keywords
2. Google Search via Serper API (top 10 results)
3. Filter out social media/non-scrapeable domains (keep top 3)
4. Gemini AI selects best URLs for content analysis
5. Scrape each URL (simple HTTP fetch with text extraction)
6. Gemini AI summarizes each page's content
7. Combine competitor summaries
8. Gemini AI generates comprehensive content brief ("Britta" persona)
9. Format and collect brief

## Key Files
- `server/workflow.ts` - Core workflow engine (all n8n logic)
- `server/routes.ts` - API routes (SSE for progress, Excel download)
- `server/storage.ts` - In-memory job storage
- `client/src/pages/home.tsx` - Main UI page
- `shared/schema.ts` - Shared types and validation

## Environment Variables
- `SERPER_API_KEY` - For Google Search via serper.dev
- `AI_INTEGRATIONS_GEMINI_API_KEY` - Auto-provided by Replit
- `AI_INTEGRATIONS_GEMINI_BASE_URL` - Auto-provided by Replit

## API Endpoints
- `POST /api/generate-briefs` - SSE stream, accepts `{ sheetUrl }`, streams progress events
- `GET /api/download/:jobId` - Downloads content_briefs.xlsx

## Excel Output Format
- One sheet per keyword (sheet name = keyword)
- Full brief content in column A
- Filename: content_briefs.xlsx
