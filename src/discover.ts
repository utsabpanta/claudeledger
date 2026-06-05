/**
 * Filesystem discovery: locate the Claude Code data root, enumerate session
 * files, and decode project directory names into readable paths.
 *
 * PRIVACY: every path ccstats reads is derived here, from a local directory
 * under the user's home (or an explicit override). Nothing in this file — or
 * anywhere in ccstats — opens a network connection. This is the whole point of
 * the tool; keep it that way.
 */

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import type { SessionFile } from "./types.js";

/** Options controlling where session files are read from. */
export interface DiscoverOptions {
  /** Explicit `--root` override (wins over everything). */
  root?: string;
}

/**
 * Resolve the `.claude` root directory.
 *
 * Precedence: `--root` flag > `CLAUDE_ROOT` env var > `~/.claude`. Some users
 * relocate the directory, so both overrides are honored. On Windows this still
 * resolves correctly because {@link homedir} returns `%USERPROFILE%`.
 */
export function resolveRoot(opts: DiscoverOptions = {}): string {
  if (opts.root && opts.root.trim() !== "") return opts.root;
  const envRoot = process.env.CLAUDE_ROOT;
  if (envRoot && envRoot.trim() !== "") return envRoot;
  return join(homedir(), ".claude");
}

/**
 * Decode a url-encoded project directory name back into a filesystem path.
 *
 * Claude Code replaces every `/` in the absolute project path with `-`, so
 * `-Users-me-code-app` becomes `/Users/me/code/app`. This is lossy — a real
 * directory containing a literal `-` is indistinguishable from a separator —
 * but it matches how Claude Code encodes the names, which is all we can do.
 */
export function decodeProjectDir(dir: string): string {
  // Leading `-` represents the leading `/` of an absolute path.
  return dir.replace(/-/g, "/");
}

/**
 * The result of {@link discoverSessions}. When the projects directory is
 * absent we return `found: false` with the path we looked at, so the CLI can
 * print a friendly message instead of a stack trace.
 */
export interface DiscoverResult {
  /** The resolved `.claude` root that was searched. */
  root: string;
  /** The `projects` directory under {@link root}. */
  projectsDir: string;
  /** Whether {@link projectsDir} exists and is a directory. */
  found: boolean;
  /** Discovered session files (empty when `found` is false). */
  sessions: SessionFile[];
}

/**
 * Enumerate every `.jsonl` session file under `<root>/projects/<project>/`.
 *
 * Re-scans the filesystem on every call — Claude Code auto-deletes old
 * sessions, so a file seen previously may be gone. Unreadable project
 * directories are skipped rather than fatal.
 */
export function discoverSessions(opts: DiscoverOptions = {}): DiscoverResult {
  const root = resolveRoot(opts);
  const projectsDir = join(root, "projects");

  if (!isDirectory(projectsDir)) {
    return { root, projectsDir, found: false, sessions: [] };
  }

  const sessions: SessionFile[] = [];
  for (const projectDir of safeReaddir(projectsDir)) {
    const projectAbs = join(projectsDir, projectDir);
    if (!isDirectory(projectAbs)) continue;

    const projectPath = decodeProjectDir(projectDir);
    const projectName = basename(projectPath) || projectPath;

    // Walk the project subtree. Top-level `.jsonl` files are sessions; nested
    // ones (under `<session>/subagents/`) are subagent transcripts.
    for (const { filePath, depth } of walkJsonl(projectAbs)) {
      sessions.push({
        path: filePath,
        sessionId: basename(filePath).slice(0, -".jsonl".length),
        projectDir,
        projectPath,
        projectName,
        isSubagent: depth > 0,
      });
    }
  }

  return { root, projectsDir, found: true, sessions };
}

/**
 * Yield every `.jsonl` file under `dir`, with its depth relative to `dir`
 * (0 = directly inside `dir`). Bounded recursion guards against runaway depth
 * and symlink loops in an unexpected layout.
 */
function* walkJsonl(
  dir: string,
  depth = 0,
  maxDepth = 8,
): Generator<{ filePath: string; depth: number }> {
  if (depth > maxDepth) return;
  for (const entry of safeReaddir(dir)) {
    const entryAbs = join(dir, entry);
    if (entry.endsWith(".jsonl") && isFile(entryAbs)) {
      yield { filePath: entryAbs, depth };
    } else if (isDirectory(entryAbs)) {
      yield* walkJsonl(entryAbs, depth + 1, maxDepth);
    }
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}
