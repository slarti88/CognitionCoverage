# Cognition Coverage — Pi Extension Implementation Plan

## Overview

Build `cogcov` as a Pi coding agent extension (TypeScript, project-level at `.pi/extensions/cogcov/`). The extension registers a `/cogcov` slash command that launches an interactive TUI for MCQ-based codebase coverage tracking.

Pi handles the UI runtime and keyboard input. AI calls are made using the `openai` SDK against whichever provider Pi is configured with (Anthropic, OpenAI, Google, Groq, etc.) — no Pi session is created for analysis or question generation, so nothing appears in the main chat.

---

## Project File Structure

```
.pi/extensions/cogcov/
├── index.ts           # Extension entry point: register /cogcov command
├── package.json       # npm deps: openai
├── types.ts           # All TypeScript interfaces and types
├── store.ts           # .cogcov/ state persistence (read/write JSON)
├── git.ts             # Git diff integration for coverage invalidation
├── codebase.ts        # File walker, line counter, code chunker
├── ai.ts              # Direct Anthropic SDK calls (background, silent)
├── prompts.ts         # Prompt templates for analysis and question gen
├── coverage.ts        # Coverage % calculations (line, tool, arch)
└── ui/
    ├── menu.ts        # Main menu TUI component
    ├── question.ts    # MCQ display and answer handling TUI
    └── report.ts      # Coverage report with ASCII progress bars
```

### State Storage (at codebase root)

```
.cogcov/
├── config.toml        # Provider config override (provider, model, api_key)
├── state.json         # Coverage data + question cache + asked question IDs
└── analysis.json      # Detected tools + architecture decisions
```

---

## Data Structures (`types.ts`)

```typescript
type QuestionCategory =
  | { kind: "lines_of_code"; file: string; startLine: number; endLine: number }
  | { kind: "tool"; toolName: string }
  | { kind: "architecture"; decisionId: string }
  | { kind: "file_class"; file: string };

interface Question {
  id: string;                        // crypto.randomUUID()
  category: QuestionCategory;
  text: string;
  options: [string, string, string]; // always exactly 3 options
  correctIndex: 0 | 1 | 2;
  explanation: string;
  codeContext?: string;              // snippet shown above the question
}

interface LineRange {
  startLine: number;
  endLine: number;
}

interface CoverageState {
  lineCoverage: Record<string, LineRange[]>;     // file path → covered ranges
  toolCoverage: Record<string, boolean>;          // tool name → covered
  archCoverage: Record<string, boolean>;          // decision id → covered
  coveredFileCommits: Record<string, string>;     // file path → git commit hash at coverage time
  questionCache: Question[];
  askedQuestionIds: string[];
}

interface ToolEntry {
  name: string;
  description: string;
  source: string;                    // which file references it (e.g. "Cargo.toml")
}

interface ArchDecision {
  id: string;                        // e.g. "arch_001"
  name: string;
  description: string;
}

interface CodebaseAnalysis {
  tools: ToolEntry[];
  architectureDecisions: ArchDecision[];
}
```

---

## AI Integration (`ai.ts`)

**Strategy**: Use the `openai` npm package against an OpenAI-compatible endpoint. All Pi-supported providers expose one. No Pi session is created; nothing appears in the conversation.

### Pi Config File Locations (confirmed)

- `~/.pi/agent/settings.json` — `{ defaultProvider: string, defaultModel: string }`
- `~/.pi/agent/auth.json` — `{ [provider]: AuthEntry }`

```typescript
// Auth entry shapes in auth.json
type AuthEntry =
  | { type: "api_key"; key: string }
  | { type: "oauth"; access: string; refresh: string; expires: number };
```

### Provider → BaseURL Map

```typescript
const PROVIDER_BASE_URLS: Record<string, string> = {
  anthropic:  "https://api.anthropic.com/v1",
  openai:     "https://api.openai.com/v1",
  google:     "https://generativelanguage.googleapis.com/v1beta/openai",
  groq:       "https://api.groq.com/openai/v1",
  mistral:    "https://api.mistral.ai/v1",
  cerebras:   "https://api.cerebras.ai/v1",
  xai:        "https://api.x.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
};
// Unknown providers fall back to "https://api.openai.com/v1"
```

### Provider Config Resolution (priority order)

1. **`.cogcov/config.toml`** — explicit override stored by the user
2. **`~/.pi/agent/settings.json` + `~/.pi/agent/auth.json`** — auto-detect Pi's active provider
   - Read `defaultProvider` and `defaultModel` from settings
   - Read the matching auth entry; extract the API key:
     - `type: "api_key"` → use `key` directly
     - `type: "oauth"` → use `access` if `expires > Date.now()`, else warn and fall through
3. **Prompt user** via `ctx.ui.input()` for provider, model, and API key; save to `.cogcov/config.toml`

```typescript
interface ProviderConfig {
  provider: string; // e.g. "anthropic"
  model:    string; // e.g. "claude-opus-4-6"
  apiKey:   string;
}

function resolveProviderConfig(ctx: CommandContext): ProviderConfig {
  // 1. Stored override
  const stored = loadConfig(ctx.cwd);
  if (stored?.provider && stored?.model && stored?.apiKey) return stored;

  // 2. Pi settings
  const piSettings = readPiSettings(); // ~/.pi/agent/settings.json
  const piAuth     = readPiAuth();     // ~/.pi/agent/auth.json
  if (piSettings && piAuth) {
    const { defaultProvider: provider, defaultModel: model } = piSettings;
    const entry = piAuth[provider];
    if (entry) {
      const apiKey =
        entry.type === "api_key"
          ? entry.key
          : entry.type === "oauth" && entry.expires > Date.now()
          ? entry.access
          : null;
      if (apiKey) return { provider, model, apiKey };
      if (entry.type === "oauth") {
        ctx.ui.setStatus("cogcov", "⚠ Pi OAuth token expired — please re-run /login in Pi");
      }
    }
  }

  // 3. Prompt user and persist
  const provider = await ctx.ui.input("Provider (e.g. anthropic, openai, google)", "anthropic");
  const model    = await ctx.ui.input("Model ID", "claude-opus-4-6");
  const apiKey   = await ctx.ui.input(`${provider} API key`, "");
  saveConfig(ctx.cwd, { provider, model, apiKey });
  return { provider, model, apiKey };
}
```

Config file format (`.cogcov/config.toml`):
```toml
provider = "anthropic"
model    = "claude-opus-4-6"
api_key  = "sk-ant-..."
```

### Core Caller

```typescript
import OpenAI from "openai";

async function callAI(
  userPrompt: string,
  systemPrompt: string,
  maxTokens = 8192,
  ctx: CommandContext
): Promise<string> {
  const { provider, model, apiKey } = resolveProviderConfig(ctx);
  const baseURL = PROVIDER_BASE_URLS[provider] ?? "https://api.openai.com/v1";
  const client = new OpenAI({ apiKey, baseURL });

  const response = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt   },
    ],
  });
  const text = response.choices[0]?.message?.content;
  if (!text) throw new Error("Empty response from AI provider");
  return text;
}
```

---

## Prompts (`prompts.ts`)

### 1. Codebase Analysis Prompt

**Input**: dependency file contents + directory tree + sample source files

**System prompt**:
```
You are a software architecture analyst. Analyze the provided codebase and return ONLY
valid JSON with no markdown fences. The response must be parseable by JSON.parse().
```

**User prompt template**:
```
Analyze this codebase and return JSON matching this exact shape:
{
  "tools": [{ "name": "...", "description": "one-line purpose", "source": "Cargo.toml" }],
  "architectureDecisions": [{ "id": "arch_001", "name": "...", "description": "..." }]
}

Identify:
- All significant libraries/frameworks found in dependency files
- Key architecture decisions visible in the code (auth patterns, data patterns,
  concurrency model, API style, storage choices, etc.)

Directory structure:
{directoryTree}

Dependency files:
{dependencyFileContents}

Sample source files:
{sampleSourceFiles}
```

### 2. Question Generation Prompt

**Input**: code chunks with line metadata + already-covered ranges + desired count

**System prompt**:
```
You are a technical quiz author. Generate MCQ questions about the provided source code.
Return ONLY a valid JSON array, no markdown. Each question must test genuine understanding,
not trivia. Wrong answer options must be plausible.
```

**User prompt template**:
```
Generate {count} multiple-choice questions about this codebase.
Return a JSON array where each item matches this shape exactly:
{
  "id": "q_{8-char random hex}",
  "category": "lines_of_code" | "tool" | "architecture",
  "file": "relative/path.ts",       // for lines_of_code questions
  "startLine": 10,                   // for lines_of_code questions
  "endLine": 25,                     // for lines_of_code questions
  "toolName": "...",                 // for tool questions
  "decisionId": "arch_001",          // for architecture questions
  "codeContext": "...code snippet...", // include for lines_of_code
  "text": "Question text?",
  "options": ["Option A", "Option B", "Option C"],
  "correctIndex": 0,
  "explanation": "Why the correct answer is right."
}

Do NOT generate questions covering these already-covered areas:
- Lines: {coveredLineRanges}
- Tools: {coveredTools}
- Architecture decisions: {coveredArchDecisions}

Target distribution: 60% lines_of_code, 20% tool, 20% architecture

Source code chunks:
{codeChunks}

Tool and architecture context:
{analysisJson}
```

---

## Codebase Walking (`codebase.ts`)

### Skip Rules

**Directories** (never recurse into): `node_modules`, `target`, `.git`, `dist`, `build`,
`__pycache__`, `.next`, `vendor`, `coverage`, `.cogcov`

**Files** (skip): binary files, files > 500KB, files matching `*.min.js`, `*.lock`,
`*.map`, `*.snap`

**Generated file heuristic**: skip if first 3 lines contain "generated", "auto-generated",
or "do not edit"

### Dependency File Detection

Recognized dependency files (read in full for analysis):
`Cargo.toml`, `package.json`, `go.mod`, `requirements.txt`, `pyproject.toml`,
`pom.xml`, `build.gradle`, `*.csproj`

### Line Counting

Count only lines that are not:
- Blank (empty or whitespace-only)
- Single-line comments starting with `//`, `#`, `--`, `<!--`, `*`

### Code Chunking (for question generation)

- Target ~150 lines per chunk
- Break at function/class boundaries when possible (heuristic: line starts with `fn `,
  `function `, `class `, `def `, `pub fn `, etc.)
- Each chunk carries metadata: `{ file, startLine, endLine, content }`
- Prioritize entry points (main.rs, index.ts, main.go, app.py) and largest files first

---

## Coverage Logic (`coverage.ts`)

### Line Coverage

```
coveredLines = sum of (endLine - startLine + 1) for all ranges in lineCoverage
totalLines   = total non-blank, non-comment lines across all tracked files
linePercent  = coveredLines / totalLines * 100
```

When a question is answered correctly, the question's `(file, startLine, endLine)` range is
merged into any existing ranges for that file (overlapping ranges are unioned).

### Tool Coverage

```
coveredTools = count of true values in toolCoverage
totalTools   = tools array length in analysis.json
toolPercent  = coveredTools / totalTools * 100
```

### Architecture Coverage

```
coveredArch  = count of true values in archCoverage
totalArch    = architectureDecisions array length in analysis.json
archPercent  = coveredArch / totalArch * 100
```

### Git Invalidation

Run on every `/cogcov` invocation before showing the menu:

```typescript
const changedFiles = await git.getChangedFiles(cwd); // git diff HEAD --name-only
const invalidated: string[] = [];
for (const file of changedFiles) {
  if (state.lineCoverage[file]) {
    delete state.lineCoverage[file];
    delete state.coveredFileCommits[file];
    invalidated.push(file);
  }
}
if (invalidated.length > 0) {
  // show warning in report / notify user
}
```

If not in a git repo: skip invalidation, show a one-time warning.

---

## CLI Flow

### Command Registration (`index.ts`)

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerCommand("cogcov", {
    description: "Cognition Coverage — test your understanding of this codebase",
    handler: async (args, ctx) => {
      await runCogcov(ctx);
    },
  });
}
```

### First Run

```
/cogcov
  → .cogcov/ doesn't exist
  → resolveProviderConfig() — auto-detects from Pi settings, or prompts user
  → ctx.ui.setStatus("cogcov", "Analyzing codebase...")
  → callAI(analysisPrompt) → save analysis.json
  → ctx.ui.setStatus("cogcov", "Generating questions (20)...")
  → callAI(questionGenPrompt) → save state.json with 20 questions
  → ctx.ui.setStatus("cogcov", "")
  → Show main menu
```

### Subsequent Runs

```
/cogcov
  → Load state.json + analysis.json
  → git diff → invalidate stale coverage, notify user if any files invalidated
  → If questionCache.length < 5:
      trigger callAI(questionGenPrompt) async (fire-and-forget, saves on completion)
  → Show main menu
```

### Main Menu (`ui/menu.ts`)

```
╔══════════════════════════════════════╗
║   Cognition Coverage                 ║
║   Line: 12%  Tool: 0%  Arch: 25%    ║
╠══════════════════════════════════════╣
║  [1] Ask a question                  ║
║  [2] View coverage report            ║
║  [3] Quit                            ║
╚══════════════════════════════════════╝
```

Navigation: number keys 1/2/3 or arrow keys + Enter.

### Question Flow (`ui/question.ts`)

```
src/auth/jwt.rs  (lines 42–58)
──────────────────────────────────────
42  fn verify_token(token: &str) -> Result<Claims> {
43      let key = DecodingKey::from_secret(SECRET.as_ref());
...
──────────────────────────────────────
What does `DecodingKey::from_secret` do in this context?
  A) Encodes a JWT payload into a signed token
  B) Creates a key used to verify a JWT's signature
  C) Hashes the secret for storage in the database
Your answer (A/B/C):
```

- User presses A, B, or C (case-insensitive)
- If correct: show "Correct! ✓" + explanation + update coverage
- If wrong: show "Incorrect. The correct answer was B." + explanation, no coverage awarded
- Press any key to return to menu

### Coverage Report (`ui/report.ts`)

```
─── Cognition Coverage Report ──────────────────────
 Line Coverage       ████████░░░░░░░░░  47%  (234/498 lines)
 Tool Coverage       ██████░░░░░░░░░░░  37%  (3/8 tools)
 Architecture        ██████████░░░░░░░  60%  (3/5 decisions)
─────────────────────────────────────────────────────
 Stale coverage (files modified since last answer):
   - src/auth/session.rs  (lines 10–30 invalidated)
─────────────────────────────────────────────────────
 [Q] Back to menu
```

---

## State Persistence (`store.ts`)

```typescript
const COGCOV_DIR = ".cogcov";
const STATE_FILE = ".cogcov/state.json";
const ANALYSIS_FILE = ".cogcov/analysis.json";
const CONFIG_FILE = ".cogcov/config.toml";

// Initialize empty state
function emptyState(): CoverageState {
  return {
    lineCoverage: {},
    toolCoverage: {},
    archCoverage: {},
    coveredFileCommits: {},
    questionCache: [],
    askedQuestionIds: [],
  };
}

function loadState(cwd: string): CoverageState { ... }
function saveState(cwd: string, state: CoverageState): void { ... }
function loadAnalysis(cwd: string): CodebaseAnalysis | null { ... }
function saveAnalysis(cwd: string, analysis: CodebaseAnalysis): void { ... }
function isFirstRun(cwd: string): boolean { ... }
```

All JSON files are pretty-printed (2-space indent) for readability.
The `.cogcov/` directory should be added to `.gitignore`.

---

## Git Integration (`git.ts`)

```typescript
import { exec } from "node:child_process";
import { promisify } from "node:util";
const execAsync = promisify(exec);

async function getChangedFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync("git diff HEAD --name-only", { cwd });
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    return []; // not a git repo or git not available
  }
}

async function isGitRepo(cwd: string): Promise<boolean> { ... }

async function getCurrentCommit(cwd: string): Promise<string | null> { ... }
```

---

## Implementation Phases

### Phase 1 — Foundation

Files: `types.ts`, `store.ts`, `git.ts`, `codebase.ts`

- Define all types and interfaces
- Implement `.cogcov/` directory init, JSON read/write helpers
- Implement `git diff HEAD --name-only` wrapper + git repo detection
- Implement recursive file walker with skip rules
- Implement line counter (excludes blanks + comments)
- Implement file chunker (~150 lines, metadata-tagged)

**Deliverable**: Can walk a codebase, count lines, detect git changes.

### Phase 2 — AI Layer

Files: `prompts.ts`, `ai.ts`

- Write analysis prompt template + question generation prompt template
- Implement `readPiSettings()` and `readPiAuth()` helpers (confirmed paths: `~/.pi/agent/settings.json`, `~/.pi/agent/auth.json`)
- Implement `resolveProviderConfig()`: Pi settings → stored config → user prompt
- Implement `callAI()` wrapper using `openai` SDK with dynamic `baseURL` per provider
- Implement JSON response parser with validation and retry on malformed output
- Manual smoke test: point at this repo, run analysis with Pi's active provider, inspect `analysis.json`
- Manual smoke test: run question generation, inspect generated questions

**Deliverable**: Can silently call the Pi-configured provider and get structured JSON back.

### Phase 3 — Coverage Logic

File: `coverage.ts`

- Implement line range merging (union of overlapping ranges)
- Implement coverage percentage calculations for all three types
- Implement git invalidation logic (integrated with store)
- Write unit tests for range merging edge cases

**Deliverable**: Coverage math is correct and invalidation works.

### Phase 4 — UI Components

Files: `ui/menu.ts`, `ui/question.ts`, `ui/report.ts`

- Build main menu using `ctx.ui.custom()` (reference: snake.ts, question.ts examples)
- Build MCQ question display with A/B/C keyboard handling
- Build coverage report with ASCII progress bars
- Handle window resize gracefully
- Test UI components in isolation via a stub command

**Deliverable**: Full interactive TUI works end-to-end.

### Phase 5 — Wiring & Integration

File: `index.ts`

- Register `/cogcov` command
- First-run detection and setup flow (with status indicators)
- Subsequent-run flow (load → git invalidation → cache check → menu)
- Background question cache refill (async, fires when cache < 5)
- Connect all phases
- End-to-end test against a real project

**Deliverable**: `/cogcov` command is fully functional.

---

## Open Questions (investigate during implementation)

1. ~~**Pi settings format**~~ **Resolved**: Pi uses two files:
   - `~/.pi/agent/settings.json` → `{ defaultProvider, defaultModel }`
   - `~/.pi/agent/auth.json` → `{ [provider]: { type: "oauth"|"api_key", access/key, expires } }`
   For OAuth (e.g. Anthropic): use `access` token as the API key, guarded by `expires > Date.now()`.

2. **jiti + npm deps**: Does Pi auto-install `package.json` deps for extension
   directories, or does the user need to `cd .pi/extensions/cogcov && npm install`?
   Check Pi docs / source for extension loading behavior.

3. **`ctx.ui.custom()` keyboard API**: Exact signature for keypress handlers
   inside custom components. Reference `question.ts` and `snake.ts` examples in
   `packages/coding-agent/examples/extensions/`.

4. **`@mariozechner/pi-tui` text rendering**: What primitives are available for
   drawing boxes, progress bars, colored text? Reference existing examples to
   avoid reinventing wheel.
