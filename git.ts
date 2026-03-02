import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execAsync("git rev-parse --git-dir", { cwd });
    return true;
  } catch {
    return false;
  }
}

export async function getChangedFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync("git diff HEAD --name-only", { cwd });
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export async function getCurrentCommit(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync("git rev-parse HEAD", { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
