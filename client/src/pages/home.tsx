import { useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  FileSpreadsheet,
  Download,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Search,
  Brain,
  Globe,
  Sparkles,
  ArrowRight,
} from "lucide-react";
import ExcelJS from "exceljs";
import type { ProgressEvent, BriefResult, StructuredBrief } from "@shared/schema";

type Status = "idle" | "processing" | "complete" | "error";

interface CompletedKeyword {
  keyword: string;
  country?: string;
  success: boolean;
  error?: string;
}

interface KeywordProcessResult {
  success: boolean;
  error?: string;
}

const KEYWORD_COOLDOWN_MS = 2500;

function sanitizeCellText(value: string) {
  return String(value ?? "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\uFFFD/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function createUniqueSheetName(baseName: string, usedNames: Set<string>) {
  const normalizedBase = sanitizeCellText(baseName).replace(/[\\/*?[\]:]/g, "").trim() || "Sheet";
  let candidate = normalizedBase.substring(0, 31);
  let suffix = 1;
  while (usedNames.has(candidate)) {
    const suffixText = `_${suffix}`;
    candidate = `${normalizedBase.substring(0, Math.max(0, 31 - suffixText.length))}${suffixText}`;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function addKeyValueRow(worksheet: ExcelJS.Worksheet, label: string, value: string) {
  const row = worksheet.addRow([sanitizeCellText(label), sanitizeCellText(value)]);
  row.getCell(1).font = { bold: true };
  row.getCell(1).alignment = { vertical: "top" };
  row.getCell(2).alignment = { wrapText: true, vertical: "top" };
}

function addBulletRows(worksheet: ExcelJS.Worksheet, heading: string, items: string[]) {
  const values = items.length ? items.map((item) => `* ${item}`).join("\n") : "* None specified";
  addKeyValueRow(worksheet, heading, values);
}

function populateBriefWorksheet(worksheet: ExcelJS.Worksheet, brief: BriefResult) {
  worksheet.columns = [
    { width: 24 },
    { width: 100 },
    { width: 80 },
    { width: 80 },
  ];

  const structured = brief.structured_brief as StructuredBrief | undefined;

  const titleRow = worksheet.addRow([sanitizeCellText(`Content Brief: ${brief.keyword}`)]);
  titleRow.getCell(1).font = { bold: true, size: 16 };
  worksheet.mergeCells(`A${titleRow.number}:D${titleRow.number}`);

  addKeyValueRow(worksheet, "Keyword", brief.keyword);
  addKeyValueRow(worksheet, "Country", brief.country || "Not specified");
  if (brief.google_doc_url) addKeyValueRow(worksheet, "Google Doc", brief.google_doc_url);
  addKeyValueRow(worksheet, "Generated", brief.timestamp);

  if (structured) {
    worksheet.addRow([]);
    const quickHeader = worksheet.addRow([sanitizeCellText("Quick Notes")]);
    quickHeader.getCell(1).font = { bold: true, size: 14 };
    worksheet.mergeCells(`A${quickHeader.number}:D${quickHeader.number}`);
    addKeyValueRow(worksheet, "H1", structured.h1);
    addKeyValueRow(worksheet, "Search Angle", structured.search_angle);
    addKeyValueRow(worksheet, "Word Count", structured.word_count_range);
    addBulletRows(worksheet, "Title Options", structured.title_options);
    addBulletRows(worksheet, "FAQ Questions", structured.faq_questions);
  }

  worksheet.addRow([]);
  const briefHeader = worksheet.addRow([sanitizeCellText("Copy Ready Brief")]);
  briefHeader.getCell(1).font = { bold: true, size: 14 };
  worksheet.mergeCells(`A${briefHeader.number}:D${briefHeader.number}`);
  for (const line of brief.brief_content.split("\n")) {
    const row = worksheet.addRow([sanitizeCellText(line)]);
    worksheet.mergeCells(`A${row.number}:D${row.number}`);
    row.getCell(1).alignment = { wrapText: true, vertical: "top" };
    if (line.startsWith("CONTENT BRIEF:") || line.startsWith("H1:") || line.startsWith("H2:") || line.startsWith("  H3:")) {
      row.getCell(1).font = { bold: true };
    }
  }
}

export default function Home() {
  const [sheetUrl, setSheetUrl] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [progressMessage, setProgressMessage] = useState("");
  const [currentStep, setCurrentStep] = useState("");
  const [currentKeyword, setCurrentKeyword] = useState("");
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(0);
  const [current, setCurrent] = useState(0);
  const [completedKeywords, setCompletedKeywords] = useState<CompletedKeyword[]>([]);
  const [allBriefs, setAllBriefs] = useState<BriefResult[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const maxProgressRef = useRef(0);
  const maxCurrentRef = useRef(0);
  const { toast } = useToast();

  const getStepIcon = (type: string) => {
    switch (type) {
      case "searching": return <Search className="h-4 w-4 animate-pulse" />;
      case "filtering": return <Brain className="h-4 w-4 animate-pulse" />;
      case "scraping": return <Globe className="h-4 w-4 animate-pulse" />;
      case "summarizing": return <Brain className="h-4 w-4 animate-pulse" />;
      case "generating": return <Sparkles className="h-4 w-4 animate-pulse" />;
      default: return <Loader2 className="h-4 w-4 animate-spin" />;
    }
  };

  const processKeyword = async (
    item: { keyword: string; country?: string; rowIndex: number },
    sheetUrl: string,
    index: number,
    total: number
  ): Promise<KeywordProcessResult> => {
    let retries = 3;
    const { keyword, country, rowIndex } = item;
    while (retries > 0) {
      try {
        const response = await fetch("/api/process-keyword", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keyword, country, rowIndex, sheetUrl, index, total }),
        });

        if (!response.ok) throw new Error(`Failed to process keyword: ${keyword}`);

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response stream");

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));

                if (event.type === "done") {
                  setAllBriefs((prev) => [...prev, event.brief]);
                  setCompletedKeywords((prev) => [...prev, { keyword: keyword, country: country, success: true }]);
                  return { success: true };
                }

              const progressEvent = event as ProgressEvent;

              if (progressEvent.total) setTotal(progressEvent.total);
              if (progressEvent.current) {
                maxCurrentRef.current = Math.max(maxCurrentRef.current, progressEvent.current);
                setCurrent(maxCurrentRef.current);
              }
              if (progressEvent.keyword) setCurrentKeyword(progressEvent.keyword);
              setCurrentStep(progressEvent.type);
              setProgressMessage(progressEvent.message);

              if (progressEvent.total && progressEvent.current) {
                const baseProgress = ((progressEvent.current - 1) / progressEvent.total) * 100;
                let stepProgress = 0;
                switch (progressEvent.type) {
                  case "searching": stepProgress = 10; break;
                  case "filtering": stepProgress = 25; break;
                  case "scraping": stepProgress = 40; break;
                  case "summarizing": stepProgress = 60; break;
                  case "generating": stepProgress = 80; break;
                  case "keyword_complete": stepProgress = 100; break;
                }
                const totalProgress = baseProgress + (stepProgress / progressEvent.total);
                maxProgressRef.current = Math.max(maxProgressRef.current, Math.min(totalProgress, 99));
                setProgress(maxProgressRef.current);
              }

              if (progressEvent.type === "error") {
                throw new Error(progressEvent.message);
              }
            } catch (e: any) {
              if (e.message.includes("Unexpected end of JSON input")) continue;
              throw e;
            }
          }
        }
        return { success: true };
      } catch (error: any) {
        retries--;
        if (retries > 0) {
          setProgressMessage(`Retrying "${keyword}" (${3 - retries}/3)...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
        } else {
          setCompletedKeywords((prev) => [...prev, { keyword, country, success: false, error: error.message }]);
          console.error(`Error processing "${keyword}" after retries:`, error);
          return { success: false, error: error.message };
        }
      }
    }
    return { success: false, error: `Failed to process keyword: "${keyword}"` };
  };

  const handleGenerate = useCallback(async () => {
    if (!sheetUrl.trim()) {
      toast({ title: "Please enter a Google Sheet URL", variant: "destructive" });
      return;
    }

    if (!sheetUrl.includes("docs.google.com/spreadsheets")) {
      toast({ title: "Please enter a valid Google Sheets URL", variant: "destructive" });
      return;
    }

    setStatus("processing");
    setProgress(0);
    setTotal(0);
    setCurrent(0);
    setCompletedKeywords([]);
    setAllBriefs([]);
    setErrorMessage("");
    setCurrentStep("");
    setCurrentKeyword("");
    setProgressMessage("Fetching keywords...");
    maxProgressRef.current = 0;
    maxCurrentRef.current = 0;

    try {
      // Step 1: Get keywords
      const kwResponse = await fetch("/api/get-keywords", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sheetUrl: sheetUrl.trim() }),
      });

      if (!kwResponse.ok) {
        const err = await kwResponse.json();
        throw new Error(err.error || "Failed to fetch keywords");
      }

      const { keywords } = await kwResponse.json();
      if (!keywords || keywords.length === 0) {
        throw new Error("No keywords found in the sheet");
      }

      setTotal(keywords.length);

      // Step 2: Process keywords
      const failures: Array<{ keyword: string; error: string }> = [];
      for (let i = 0; i < keywords.length; i++) {
        const result = await processKeyword(keywords[i], sheetUrl.trim(), i, keywords.length);
        if (!result.success) {
          const failedKeyword = keywords[i].keyword;
          failures.push({
            keyword: failedKeyword,
            error: result.error || `Failed to process keyword: "${failedKeyword}"`,
          });
          maxCurrentRef.current = Math.max(maxCurrentRef.current, i + 1);
          setCurrent(maxCurrentRef.current);
          const failureProgress = ((i + 1) / keywords.length) * 100;
          maxProgressRef.current = Math.max(maxProgressRef.current, failureProgress);
          setProgress(Math.min(maxProgressRef.current, 99));
        }
        if (i < keywords.length - 1) {
          setProgressMessage(`Cooling down before processing the next keyword...`);
          await new Promise((resolve) => setTimeout(resolve, KEYWORD_COOLDOWN_MS));
        }
      }

      setStatus("complete");
      setProgress(100);
      maxProgressRef.current = 100;
      const successCount = keywords.length - failures.length;
      setProgressMessage(
        failures.length
          ? `Completed processing all keywords. Success: ${successCount}, Failed: ${failures.length}.`
          : "Completed! Generated briefs for all keywords."
      );
      if (failures.length) {
        const message = `Processed all keywords. Failed: ${failures.map((failure) => failure.keyword).join(", ")}`;
        setErrorMessage(message);
        toast({ title: "Completed With Some Failures", description: message, variant: "destructive" });
      }
      
    } catch (error) {
      const message = error instanceof Error ? error.message : "An error occurred";
      setErrorMessage(message);
      setStatus("error");
      toast({ title: "Error", description: message, variant: "destructive" });
    }
  }, [sheetUrl, toast]);

  const handleDownload = async () => {
    if (allBriefs.length === 0) return;
    
    try {
      const workbook = new ExcelJS.Workbook();
      const usedSheetNames = new Set<string>();

      for (const brief of allBriefs) {
        const sheetName = createUniqueSheetName(brief.keyword, usedSheetNames);
        const worksheet = workbook.addWorksheet(sheetName);
        populateBriefWorksheet(worksheet, brief);
      }

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob(
        [buffer],
        { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      );
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "content_briefs.xlsx";
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error: any) {
      toast({ title: "Download Error", description: error.message, variant: "destructive" });
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-4 py-12 space-y-8">
        <div className="text-center space-y-3">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-sm font-medium">
            <Sparkles className="h-3.5 w-3.5" />
            AI-Powered SEO Tool
          </div>
          <h1 className="text-4xl font-bold tracking-tight text-foreground" data-testid="text-page-title">
            Content Brief Generator
          </h1>
          <p className="text-muted-foreground text-lg max-w-xl mx-auto">
            Generate comprehensive SEO content briefs from your keywords.
            Paste a Google Sheet URL with "keyword" and "country" columns and let AI do the rest.
          </p>
        </div>

        <Card className="border-border">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5 text-primary" />
              Google Sheet URL
            </CardTitle>
            <CardDescription>
              Your sheet must be publicly accessible and have columns named "keyword" and "country"
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-3">
              <Input
                data-testid="input-sheet-url"
                placeholder="https://docs.google.com/spreadsheets/d/..."
                value={sheetUrl}
                onChange={(e) => setSheetUrl(e.target.value)}
                disabled={status === "processing"}
                className="flex-1"
              />
              <Button
                data-testid="button-generate"
                onClick={handleGenerate}
                disabled={status === "processing" || !sheetUrl.trim()}
                className="gap-2 min-w-[160px]"
              >
                {status === "processing" ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Processing...
                  </>
                ) : (
                  <>
                    Generate Briefs
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {status === "processing" && (
          <Card className="border-primary/20 bg-primary/[0.02]">
            <CardContent className="pt-6 space-y-5">
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    {total > 0 ? `Keyword ${current} of ${total}` : "Starting..."}
                  </span>
                  <span className="font-medium text-primary">{Math.round(progress)}%</span>
                </div>
                <Progress value={progress} className="h-2" data-testid="progress-bar" />
              </div>

              <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                {getStepIcon(currentStep)}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate" data-testid="text-progress-message">
                    {progressMessage}
                  </p>
                  {currentKeyword && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Keyword: <span className="font-medium">{currentKeyword}</span>
                      {completedKeywords.find(k => k.keyword === currentKeyword)?.country && (
                        <> | Region: <span className="font-medium">{completedKeywords.find(k => k.keyword === currentKeyword)?.country}</span></>
                      )}
                    </p>
                  )}
                </div>
              </div>

              {completedKeywords.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Completed
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {completedKeywords.map((item, idx) => (
                      <Badge
                        key={idx}
                        variant={item.success ? "secondary" : "destructive"}
                        className="gap-1.5"
                        data-testid={`badge-keyword-${idx}`}
                        title={item.error}
                      >
                        {item.success ? (
                          <CheckCircle2 className="h-3 w-3" />
                        ) : (
                          <AlertCircle className="h-3 w-3" />
                        )}
                        {item.keyword} {item.country ? `(${item.country})` : ""}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {status === "complete" && allBriefs.length > 0 && (
          <Card className="border-green-500/30 bg-green-500/[0.03]">
            <CardContent className="pt-6 space-y-5">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-green-500/10 flex items-center justify-center">
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground" data-testid="text-complete-title">
                    Briefs Generated Successfully
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {completedKeywords.filter((k) => k.success).length} brief(s) ready for download
                  </p>
                </div>
              </div>

              {completedKeywords.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {completedKeywords.map((item, idx) => (
                    <Badge
                      key={idx}
                      variant={item.success ? "secondary" : "destructive"}
                      className="gap-1.5"
                      data-testid={`badge-result-${idx}`}
                    >
                      {item.success ? (
                        <CheckCircle2 className="h-3 w-3" />
                      ) : (
                        <AlertCircle className="h-3 w-3" />
                      )}
                      {item.keyword}
                    </Badge>
                  ))}
                </div>
              )}

              <Button
                data-testid="button-download"
                onClick={handleDownload}
                size="lg"
                className="w-full gap-2"
              >
                <Download className="h-4 w-4" />
                Download Excel File
              </Button>
            </CardContent>
          </Card>
        )}

        {status === "error" && (
          <Card className="border-destructive/30 bg-destructive/[0.03]">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-destructive/10 flex items-center justify-center">
                  <AlertCircle className="h-5 w-5 text-destructive" />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground" data-testid="text-error-title">
                    Error
                  </h3>
                  <p className="text-sm text-muted-foreground" data-testid="text-error-message">
                    {errorMessage || "Something went wrong. Please try again."}
                  </p>
                </div>
              </div>
              <Button
                data-testid="button-retry"
                variant="outline"
                className="mt-4 w-full"
                onClick={() => {
                  setStatus("idle");
                  setErrorMessage("");
                }}
              >
                Try Again
              </Button>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4">
          {[
            {
              icon: <Search className="h-5 w-5 text-primary" />,
              title: "SERP Analysis",
              desc: "Searches Google and analyzes top-ranking pages",
            },
            {
              icon: <Brain className="h-5 w-5 text-primary" />,
              title: "AI Competitor Analysis",
              desc: "Summarizes competitor content with Gemini AI",
            },
            {
              icon: <Sparkles className="h-5 w-5 text-primary" />,
              title: "Brief Generation",
              desc: "Creates detailed, actionable content briefs",
            },
          ].map((item, idx) => (
            <Card key={idx} className="border-border/60">
              <CardContent className="pt-5 pb-5 text-center space-y-2">
                <div className="mx-auto h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                  {item.icon}
                </div>
                <h3 className="font-semibold text-sm">{item.title}</h3>
                <p className="text-xs text-muted-foreground">{item.desc}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
