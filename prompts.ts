import type { CodeChunk, LineRange, Module } from "./types.js";

export const ANALYSIS_SYSTEM = `You are a software architecture analyst. Analyze the provided codebase and return ONLY valid JSON with no markdown fences. The response must be parseable by JSON.parse().`;

export const QUESTION_GEN_SYSTEM = `You are a technical quiz author. Generate MCQ questions about the provided source code. Return ONLY a valid JSON array, no markdown. Each question must test genuine understanding, not trivia. Wrong answer options must be plausible.`;

export function buildAnalysisPrompt(params: {
  directoryTree: string;
  dependencyFileContents: string;
  sampleSourceFiles: string;
}): string {
  return `Analyze this codebase and return JSON matching this exact shape:
{
  "modules": [
    {
      "id": "auth",
      "name": "Authentication",
      "description": "Handles user login and session management",
      "files": ["src/auth/index.ts", "src/auth/session.ts"]
    }
  ]
}

Identify logical modules using a hybrid strategy:
- If the codebase has clear top-level directories (e.g. src/auth/, src/api/), use them as module boundaries.
- If files are mostly at the root or mixed, group them by logical concern inferred from filenames and content.
- A module should contain 1 or more related files. Avoid single-file modules unless the file is large and self-contained.
- For small flat repos a single module is acceptable if no clear logical grouping exists.
- Only include source files in modules, not dependency/config files.
- Use the exact relative file paths as they appear in the directory tree.

Directory structure:
${params.directoryTree}

Dependency files:
${params.dependencyFileContents}

Sample source files:
${params.sampleSourceFiles}`;
}

export function buildQuestionGenPrompt(params: {
  count: number;
  coveredLineRanges: string;
  moduleSummary: string;
  codeChunks: string;
}): string {
  return `Generate ${params.count} multiple-choice questions about this codebase.
Return a JSON array where each item matches this shape exactly:
{
  "id": "q_<8-char random hex>",
  "category": "lines_of_code",
  "module": "<moduleId>",
  "file": "relative/path.ts",
  "startLine": 10,
  "endLine": 25,
  "codeContext": "...code snippet...",
  "text": "Question text?",
  "options": ["Option A", "Option B", "Option C"],
  "correctIndex": 0,
  "explanation": "Why the correct answer is right."
}

Notes:
- All questions must be of category "lines_of_code"
- "module" must be a valid module id from the module list below
- "file" and "module" must be consistent — the file must belong to that module
- "codeContext" should be the relevant code snippet (max 20 lines)
- "correctIndex" must be 0, 1, or 2

Do NOT generate questions covering these already-covered line ranges:
${params.coveredLineRanges || "none"}

Modules in this codebase:
${params.moduleSummary}

Source code (grouped by module):
${params.codeChunks}`;
}

export function formatDependencyFiles(depFiles: Array<{ path: string; content: string }>): string {
  return depFiles
    .slice(0, 10)
    .map(f => `### ${f.path}\n\`\`\`\n${f.content.slice(0, 2000)}\n\`\`\``)
    .join("\n\n");
}

export function formatSampleSourceFiles(sourceFiles: Array<{ path: string; content: string }>): string {
  return sourceFiles
    .slice(0, 5)
    .map(f => `### ${f.path}\n\`\`\`\n${f.content.slice(0, 3000)}\n\`\`\``)
    .join("\n\n");
}

export function formatModuleCodeChunks(chunks: CodeChunk[], modules: Module[]): string {
  const modNameMap = new Map(modules.map(m => [m.id, m.name]));

  const byModule = new Map<string, CodeChunk[]>();
  for (const chunk of chunks) {
    const list = byModule.get(chunk.module) ?? [];
    list.push(chunk);
    byModule.set(chunk.module, list);
  }

  const parts: string[] = [];
  for (const [moduleId, moduleChunks] of byModule) {
    const modName = modNameMap.get(moduleId) ?? moduleId;
    parts.push(`## Module: ${modName} (${moduleId})`);
    for (const c of moduleChunks) {
      parts.push(`### ${c.file} (lines ${c.startLine}–${c.endLine})\n\`\`\`\n${c.content}\n\`\`\``);
    }
  }
  return parts.join("\n\n");
}

export function formatModuleSummary(modules: Module[]): string {
  return modules
    .map(m => `- ${m.id}: ${m.name} — ${m.description} (${m.files.length} file(s))`)
    .join("\n");
}

export function formatCoveredLineRanges(lineCoverage: Record<string, LineRange[]>): string {
  const parts: string[] = [];
  for (const [file, ranges] of Object.entries(lineCoverage)) {
    if (ranges.length === 0) continue;
    const rangeStr = ranges.map(r => `${r.startLine}-${r.endLine}`).join(", ");
    parts.push(`${file}: [${rangeStr}]`);
  }
  return parts.join("; ") || "none";
}
