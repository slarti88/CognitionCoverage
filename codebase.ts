import * as fs from "node:fs";
import * as path from "node:path";
import type { WalkResult, SourceFile, DepFile, CodeChunk, Module } from "./types.js";

const SKIP_DIRS = new Set([
  "node_modules", "target", ".git", "dist", "build",
  "__pycache__", ".next", "vendor", "coverage", ".cogcov", ".pi",
]);

const SKIP_EXTENSIONS = new Set([".min.js", ".lock", ".map", ".snap"]);

const DEP_FILE_NAMES = new Set([
  "Cargo.toml", "package.json", "go.mod", "requirements.txt",
  "pyproject.toml", "pom.xml", "build.gradle",
]);

const COMMENT_PREFIXES = ["//", "#", "--", "<!--", "*"];

const FUNCTION_START = /^(fn |pub fn |pub async fn |async fn |function |async function |export function |export async function |export default function |class |export class |export default class |def |pub |impl )/;

const ENTRY_POINTS = new Set([
  "main.rs", "index.ts", "main.go", "app.py", "main.py",
  "index.js", "main.js", "index.mjs", "main.mts", "index.mts",
]);

/** Normalize path separators to forward slashes for consistent keys. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name) || (name.startsWith(".") && name !== ".");
}

function shouldSkipFile(name: string, sizeBytes: number): boolean {
  if (sizeBytes > 500 * 1024) return true;
  const lower = name.toLowerCase();
  for (const ext of SKIP_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function isBinary(buffer: Buffer): boolean {
  const check = buffer.slice(0, 512);
  for (let i = 0; i < check.length; i++) {
    if (check[i] === 0) return true;
  }
  return false;
}

function isGenerated(content: string): boolean {
  const lines = content.split("\n").slice(0, 3);
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes("generated") || lower.includes("auto-generated") || lower.includes("do not edit")) {
      return true;
    }
  }
  return false;
}

function isCsprojFile(name: string): boolean {
  return name.endsWith(".csproj");
}

export function countSignificantLines(content: string): number {
  return content.split("\n").filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    for (const prefix of COMMENT_PREFIXES) {
      if (trimmed.startsWith(prefix)) return false;
    }
    return true;
  }).length;
}

export function chunkFile(filePath: string, content: string, targetSize = 150): CodeChunk[] {
  const lines = content.split("\n");
  if (lines.length === 0) return [];

  const chunks: CodeChunk[] = [];
  let chunkStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const chunkLen = i - chunkStart;
    if (chunkLen >= targetSize) {
      // Look ahead up to 20 lines for a function boundary
      let breakAt = i;
      for (let j = i; j < Math.min(i + 20, lines.length); j++) {
        if (FUNCTION_START.test(lines[j]!.trimStart())) {
          breakAt = j;
          break;
        }
      }
      if (breakAt > chunkStart) {
        chunks.push({
          file: filePath,
          startLine: chunkStart + 1,
          endLine: breakAt,
          content: lines.slice(chunkStart, breakAt).join("\n"),
        });
        chunkStart = breakAt;
        i = breakAt - 1;
      }
    }
  }

  // Final chunk
  if (chunkStart < lines.length) {
    chunks.push({
      file: filePath,
      startLine: chunkStart + 1,
      endLine: lines.length,
      content: lines.slice(chunkStart).join("\n"),
    });
  }

  return chunks;
}

interface TreeNode {
  name: string;
  isDir: boolean;
  children: TreeNode[];
}

function buildTreeLines(nodes: TreeNode[], prefix = ""): string[] {
  const lines: string[] = [];
  nodes.forEach((node, idx) => {
    const isLast = idx === nodes.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? "    " : "│   ";
    lines.push(prefix + connector + node.name);
    if (node.isDir && node.children.length > 0) {
      lines.push(...buildTreeLines(node.children, prefix + childPrefix));
    }
  });
  return lines;
}

export function walkCodebase(cwd: string): WalkResult {
  const sourceFiles: SourceFile[] = [];
  const depFiles: DepFile[] = [];
  const treeRoot: TreeNode[] = [];

  function walk(dir: string, relDir: string, treeNodes: TreeNode[], depth: number): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Sort: directories first, then files, each alphabetically
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        const childRelDir = relDir ? `${relDir}/${entry.name}` : entry.name;
        const childNode: TreeNode = { name: entry.name + "/", isDir: true, children: [] };
        if (depth < 3) treeNodes.push(childNode);
        walk(path.join(dir, entry.name), childRelDir, depth < 3 ? childNode.children : [], depth + 1);
      } else if (entry.isFile()) {
        const absPath = path.join(dir, entry.name);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(absPath);
        } catch {
          continue;
        }

        // Dependency file detection
        if (DEP_FILE_NAMES.has(entry.name) || isCsprojFile(entry.name)) {
          try {
            const content = fs.readFileSync(absPath, "utf-8");
            const relPath = normalizePath(relDir ? `${relDir}/${entry.name}` : entry.name);
            depFiles.push({ path: relPath, content });
            if (depth < 3) treeNodes.push({ name: entry.name, isDir: false, children: [] });
          } catch {
            // skip unreadable
          }
          continue;
        }

        if (shouldSkipFile(entry.name, stat.size)) continue;

        let buffer: Buffer;
        try {
          buffer = fs.readFileSync(absPath);
        } catch {
          continue;
        }

        if (isBinary(buffer)) continue;

        const content = buffer.toString("utf-8");
        if (isGenerated(content)) continue;

        const significantLines = countSignificantLines(content);
        if (significantLines === 0) continue;

        const relPath = normalizePath(relDir ? `${relDir}/${entry.name}` : entry.name);
        sourceFiles.push({ path: relPath, content, significantLines });
        if (depth < 3) treeNodes.push({ name: entry.name, isDir: false, children: [] });
      }
    }
  }

  walk(cwd, "", treeRoot, 0);

  // Sort source files: entry points first, then by significant lines descending
  sourceFiles.sort((a, b) => {
    const aIsEntry = ENTRY_POINTS.has(path.basename(a.path));
    const bIsEntry = ENTRY_POINTS.has(path.basename(b.path));
    if (aIsEntry && !bIsEntry) return -1;
    if (!aIsEntry && bIsEntry) return 1;
    return b.significantLines - a.significantLines;
  });

  const dirTree = [".", ...buildTreeLines(treeRoot)].join("\n");

  return { sourceFiles, depFiles, dirTree };
}

/**
 * Build code chunks for question generation, distributing budget across modules.
 * Each module gets a proportional share of maxChunks, prioritizing uncovered files.
 */
export function buildModuleCodeChunks(
  sourceFiles: SourceFile[],
  modules: Module[],
  coveredFiles: Set<string> = new Set(),
  maxChunks = 30
): CodeChunk[] {
  if (modules.length === 0) {
    return buildFlatChunks(sourceFiles, coveredFiles, maxChunks, "default");
  }

  const chunksPerModule = Math.max(1, Math.floor(maxChunks / modules.length));
  const chunks: CodeChunk[] = [];

  for (const mod of modules) {
    const modFiles = sourceFiles
      .filter(f => mod.files.includes(f.path))
      .sort((a, b) => {
        const aCov = coveredFiles.has(a.path) ? 1 : 0;
        const bCov = coveredFiles.has(b.path) ? 1 : 0;
        return aCov - bCov || b.significantLines - a.significantLines;
      });

    let modChunkCount = 0;
    for (const file of modFiles) {
      if (modChunkCount >= chunksPerModule) break;
      for (const c of chunkFile(file.path, file.content)) {
        if (modChunkCount >= chunksPerModule) break;
        chunks.push({ ...c, module: mod.id });
        modChunkCount++;
      }
    }
  }

  return chunks.slice(0, maxChunks);
}

function buildFlatChunks(
  sourceFiles: SourceFile[],
  coveredFiles: Set<string>,
  maxChunks: number,
  moduleId: string
): CodeChunk[] {
  const sorted = [...sourceFiles].sort((a, b) => {
    const aCov = coveredFiles.has(a.path) ? 1 : 0;
    const bCov = coveredFiles.has(b.path) ? 1 : 0;
    return aCov - bCov || b.significantLines - a.significantLines;
  });
  const chunks: CodeChunk[] = [];
  for (const file of sorted) {
    for (const c of chunkFile(file.path, file.content)) {
      chunks.push({ ...c, module: moduleId });
      if (chunks.length >= maxChunks) return chunks;
    }
  }
  return chunks;
}
