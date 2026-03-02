import { complete, type Model, type Api, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type {
  Question, CodebaseAnalysis, ToolEntry,
  ArchDecision, CoverageState, WalkResult,
} from "./types.js";
import { buildCodeChunks } from "./codebase.js";
import {
  ANALYSIS_SYSTEM, QUESTION_GEN_SYSTEM,
  buildAnalysisPrompt, buildQuestionGenPrompt,
  formatDependencyFiles, formatSampleSourceFiles,
  formatCodeChunks, buildPromptParams,
} from "./prompts.js";

interface AICallContext {
  model: Model<Api>;
  apiKey: string | undefined;
}

async function getCallContext(ctx: ExtensionCommandContext): Promise<AICallContext> {
  const model = ctx.model;
  if (!model) throw new Error("No model selected in Pi");
  const apiKey = await ctx.modelRegistry.getApiKey(model);
  return { model, apiKey };
}

function stripMarkdownFences(text: string): string {
  return text
    .replace(/^```[a-z]*\n?/gm, "")
    .replace(/^```\s*$/gm, "")
    .trim();
}

async function callAI(
  userPrompt: string,
  systemPrompt: string,
  callCtx: AICallContext
): Promise<string> {
  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: userPrompt }],
    timestamp: Date.now(),
  };

  const response = await complete(
    callCtx.model,
    { systemPrompt, messages: [userMessage] },
    { apiKey: callCtx.apiKey, signal: undefined },
  );

  if (response.stopReason === "aborted") throw new Error("AI call was aborted");

  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map(c => c.text)
    .join("\n");

  if (!text) throw new Error("Empty response from AI provider");
  return text;
}

async function callAIWithRetry<T>(
  userPrompt: string,
  systemPrompt: string,
  callCtx: AICallContext,
  validator: (obj: unknown) => T,
  maxRetries = 2
): Promise<T> {
  let prompt = userPrompt;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const raw = await callAI(prompt, systemPrompt, callCtx);
    const cleaned = stripMarkdownFences(raw);
    try {
      const parsed = JSON.parse(cleaned);
      return validator(parsed);
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries) {
        prompt = userPrompt +
          `\n\nYour previous response could not be parsed as JSON: ${lastError.message}` +
          `\nReturn ONLY valid JSON with no markdown fences or commentary.`;
      }
    }
  }

  throw new Error(`AI returned invalid JSON after ${maxRetries + 1} attempts: ${lastError?.message}`);
}

// --- Validators ---

function normalizeToolEntry(obj: unknown): ToolEntry {
  const t = obj as Record<string, unknown>;
  return {
    name: String(t["name"] ?? ""),
    description: String(t["description"] ?? ""),
    source: String(t["source"] ?? ""),
  };
}

function normalizeArchDecision(obj: unknown): ArchDecision {
  const a = obj as Record<string, unknown>;
  return {
    id: String(a["id"] ?? `arch_${Math.floor(Math.random() * 1000).toString().padStart(3, "0")}`),
    name: String(a["name"] ?? ""),
    description: String(a["description"] ?? ""),
  };
}

function validateAnalysis(obj: unknown): CodebaseAnalysis {
  if (!obj || typeof obj !== "object") throw new Error("Response is not an object");
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o["tools"])) throw new Error("Missing 'tools' array");
  if (!Array.isArray(o["architectureDecisions"])) throw new Error("Missing 'architectureDecisions' array");
  return {
    tools: (o["tools"] as unknown[]).map(normalizeToolEntry),
    architectureDecisions: (o["architectureDecisions"] as unknown[]).map(normalizeArchDecision),
  };
}

function normalizeQuestion(obj: unknown): Question {
  const q = obj as Record<string, unknown>;

  let category: Question["category"];
  const cat = String(q["category"] ?? "lines_of_code");

  if (cat === "lines_of_code") {
    category = {
      kind: "lines_of_code",
      file: String(q["file"] ?? ""),
      startLine: Number(q["startLine"] ?? 1),
      endLine: Number(q["endLine"] ?? 1),
    };
  } else if (cat === "tool") {
    category = { kind: "tool", toolName: String(q["toolName"] ?? "") };
  } else if (cat === "architecture") {
    category = { kind: "architecture", decisionId: String(q["decisionId"] ?? "") };
  } else {
    category = { kind: "lines_of_code", file: String(q["file"] ?? ""), startLine: 1, endLine: 1 };
  }

  const options = Array.isArray(q["options"]) ? q["options"] as string[] : ["A", "B", "C"];
  const correctIndex = [0, 1, 2].includes(Number(q["correctIndex"])) ? Number(q["correctIndex"]) : 0;

  return {
    id: typeof q["id"] === "string" && q["id"]
      ? q["id"]
      : `q_${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0")}`,
    category,
    text: String(q["text"] ?? ""),
    options: [
      String(options[0] ?? ""),
      String(options[1] ?? ""),
      String(options[2] ?? ""),
    ],
    correctIndex: correctIndex as 0 | 1 | 2,
    explanation: String(q["explanation"] ?? ""),
    codeContext: typeof q["codeContext"] === "string" ? q["codeContext"] : undefined,
  };
}

function validateQuestions(obj: unknown): Question[] {
  if (!Array.isArray(obj)) throw new Error("Expected a JSON array of questions");
  if (obj.length === 0) throw new Error("Empty questions array");
  return (obj as unknown[]).map(normalizeQuestion);
}

// --- Public API ---

export async function runCodebaseAnalysis(
  walkResult: WalkResult,
  ctx: ExtensionCommandContext
): Promise<CodebaseAnalysis> {
  const callCtx = await getCallContext(ctx);
  const userPrompt = buildAnalysisPrompt({
    directoryTree: walkResult.dirTree,
    dependencyFileContents: formatDependencyFiles(walkResult.depFiles),
    sampleSourceFiles: formatSampleSourceFiles(walkResult.sourceFiles),
  });

  return callAIWithRetry(userPrompt, ANALYSIS_SYSTEM, callCtx, validateAnalysis);
}

export async function generateQuestions(
  state: CoverageState,
  analysis: CodebaseAnalysis,
  walkResult: WalkResult,
  count: number,
  ctx: ExtensionCommandContext
): Promise<Question[]> {
  const callCtx = await getCallContext(ctx);
  const coveredFiles = new Set(Object.keys(state.lineCoverage));
  const chunks = buildCodeChunks(walkResult.sourceFiles, coveredFiles);
  const { coveredLineRanges, coveredTools, coveredArchDecisions } = buildPromptParams(state, analysis);

  const userPrompt = buildQuestionGenPrompt({
    count,
    coveredLineRanges,
    coveredTools,
    coveredArchDecisions,
    codeChunks: formatCodeChunks(chunks),
    analysisJson: JSON.stringify(analysis, null, 2),
  });

  return callAIWithRetry(userPrompt, QUESTION_GEN_SYSTEM, callCtx, validateQuestions);
}
