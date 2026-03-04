import { complete, type Model, type Api, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type {
  Question, CodebaseAnalysis, Module, CoverageState, WalkResult,
} from "./types.js";
import { buildModuleCodeChunks } from "./codebase.js";
import {
  ANALYSIS_SYSTEM, QUESTION_GEN_SYSTEM,
  buildAnalysisPrompt, buildQuestionGenPrompt,
  formatDependencyFiles, formatSampleSourceFiles,
  formatModuleCodeChunks, formatModuleSummary, formatCoveredLineRanges,
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

function normalizeModule(obj: unknown): Module {
  const m = obj as Record<string, unknown>;
  return {
    id: String(m["id"] ?? `module_${Math.floor(Math.random() * 1000).toString().padStart(3, "0")}`),
    name: String(m["name"] ?? ""),
    description: String(m["description"] ?? ""),
    files: Array.isArray(m["files"]) ? (m["files"] as unknown[]).map(f => String(f)) : [],
  };
}

function validateAnalysis(obj: unknown): CodebaseAnalysis {
  if (!obj || typeof obj !== "object") throw new Error("Response is not an object");
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o["modules"])) throw new Error("Missing 'modules' array");
  return {
    modules: (o["modules"] as unknown[]).map(normalizeModule),
  };
}

function normalizeQuestion(obj: unknown): Question {
  const q = obj as Record<string, unknown>;

  const category: Question["category"] = {
    kind: "lines_of_code",
    file: String(q["file"] ?? ""),
    startLine: Number(q["startLine"] ?? 1),
    endLine: Number(q["endLine"] ?? 1),
    module: String(q["module"] ?? ""),
  };

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
  const chunks = buildModuleCodeChunks(walkResult.sourceFiles, analysis.modules, coveredFiles);

  const userPrompt = buildQuestionGenPrompt({
    count,
    coveredLineRanges: formatCoveredLineRanges(state.lineCoverage),
    moduleSummary: formatModuleSummary(analysis.modules),
    codeChunks: formatModuleCodeChunks(chunks, analysis.modules),
  });

  return callAIWithRetry(userPrompt, QUESTION_GEN_SYSTEM, callCtx, validateQuestions);
}
