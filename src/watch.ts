import { spawn } from "node:child_process";
import type { Run } from "./store.ts";
import { signalGroup } from "./process.ts";

/** A watch command must finish within this, and its output is capped. */
export const WATCH_TIMEOUT_MS = 120_000;
const MAX_WATCH_OUTPUT = 1024 * 1024;
const MAX_ITEM_ID = 200;

/** What one check of a job's watch command did. */
export interface WatchResult {
  /** Runs started for items not seen before. */
  runs: Run[];
  /** Items printed that were already seen. */
  seen: number;
  /** Why the check failed, or why some items were left for the next check. */
  error: string | null;
}

/**
 * The items a watch command printed: one JSON object a line with a string or number `id`. Blank
 * lines are skipped; anything else is an error naming the line.
 */
export function parseWatchOutput(stdout: string): { items: { id: string; payload: string }[]; error: string | null } {
  const items: { id: string; payload: string }[] = [];
  const ids = new Set<string>();
  const lines = stdout.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return { items, error: `Line ${index + 1} is not JSON` };
    }
    const id = value && typeof value === "object" && !Array.isArray(value) ? (value as { id?: unknown }).id : undefined;
    if ((typeof id !== "string" && typeof id !== "number") || String(id) === "" || String(id).length > MAX_ITEM_ID) {
      return { items, error: `Line ${index + 1} has no "id" (a string or number of up to ${MAX_ITEM_ID} characters)` };
    }
    if (ids.has(String(id))) continue;
    ids.add(String(id));
    items.push({ id: String(id), payload: JSON.stringify(value, null, 2) });
  }
  return { items, error: null };
}

/** The watch command's stdout. It runs in its own process group, which a timeout kills whole. */
export function runWatchCommand(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env });
    const stdout: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let failure: string | null = null;
    const stop = (reason: string) => {
      failure ??= reason;
      signalGroup(child.pid, "SIGKILL");
    };
    const timer = setTimeout(() => stop(`The watch command took longer than ${WATCH_TIMEOUT_MS / 1000} s`), WATCH_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_WATCH_OUTPUT) stop(`The watch command printed more than ${MAX_WATCH_OUTPUT / 1024} KiB`);
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not start the watch command: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signalGroup(child.pid, "SIGKILL");
      if (failure) return reject(new Error(failure));
      if (code !== 0) {
        // Only the start of the last line: it is shown in the UI and the server log.
        const detail = stderr.trim().split("\n").at(-1)?.slice(0, 200);
        return reject(new Error(`The watch command exited with ${code === null ? "a signal" : `code ${code}`}${detail ? `: ${detail}` : ""}`));
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

