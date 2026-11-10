import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

export const AGENT_IDS = ["pi", "claude", "codex"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const PROMPT_TOKEN = "{prompt}";

/**
 * Headless command lines for each agent. Every agent runs unattended as the owner,
 * so each preset turns off interactive approval prompts.
 */
export const AGENT_PRESETS: Record<AgentId, { label: string; command: string }> = {
  pi: { label: "Pi", command: "pi -p {prompt}" },
  claude: {
    label: "Claude Code",
    command: "claude -p {prompt} --permission-mode bypassPermissions",
  },
  // Network stays off: with it on, a sandboxed run could reach this server's loopback API.
  codex: { label: "Codex", command: "codex exec --sandbox workspace-write {prompt}" },
};

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && (AGENT_IDS as readonly string[]).includes(value);
}

/** Splits a command line like a POSIX shell would, without expansion. */
export function splitCommand(line: string): string[] {
  const args: string[] = [];
  let current = "";
  let inArg = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1]!)) current += line[++i];
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inArg = true;
    } else if (ch === "\\" && i + 1 < line.length) {
      current += line[++i];
      inArg = true;
    } else if (/\s/.test(ch)) {
      if (inArg) args.push(current);
      current = "";
      inArg = false;
    } else {
      current += ch;
      inArg = true;
    }
  }
  if (quote) throw new Error("Unterminated quote in command");
  if (inArg) args.push(current);
  return args;
}

/** Substitutes the prompt for the `{prompt}` argument, or appends it when absent. */
export function buildArgv(command: string, prompt: string): string[] {
  const args = splitCommand(command);
  if (args.length === 0) throw new Error("Command is empty");
  if (args[0] === PROMPT_TOKEN) throw new Error("Command must start with an executable");
  return args.includes(PROMPT_TOKEN)
    ? args.map((arg) => (arg === PROMPT_TOKEN ? prompt : arg))
    : [...args, prompt];
}

/** The program a command line runs, looking through a leading `env VAR=value …`. */
export function commandProgram(argv: string[]): string {
  const [first, ...rest] = argv;
  if (!first || path.basename(first) !== "env") return first ?? "";
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "-u" || arg === "--unset") i++;
    else if (!arg.startsWith("-") && !arg.includes("=")) return arg;
  }
  return first;
}

/** Resolves an executable the way spawn() will, returning its absolute path or null. */
export async function resolveExecutable(
  name: string,
  envPath = process.env.PATH ?? "",
): Promise<string | null> {
  const candidates = name.includes("/")
    ? [path.resolve(name)]
    : envPath
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, name));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return null;
}
