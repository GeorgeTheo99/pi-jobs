import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

/** The agents pi-jobs knows out of the box; Settings can add more (another Pi launcher, say). */
export const BUILTIN_AGENT_IDS = ["pi", "claude", "codex"] as const;
export type BuiltinAgentId = (typeof BUILTIN_AGENT_IDS)[number];
/** A built-in agent's id, one added in Settings such as "pi-claude", or Pi on a model alias such as "pi:gpt". */
export type AgentId = string;
/** Names for agents added in Settings: lowercase letters, digits and dashes, like a command name. */
export const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** Pi on one of its launcher's model aliases (`pi models`): "pi:<alias>" runs the pi agent as `pi <alias> …`. */
export const PI_MODEL_AGENT_PATTERN = /^pi:([a-z0-9][a-z0-9._-]{0,63})$/;

/** The model alias of a "pi:<alias>" agent, or null for any other agent. */
export function piModelOf(agent: AgentId): string | null {
  return PI_MODEL_AGENT_PATTERN.exec(agent)?.[1] ?? null;
}

export const PROMPT_TOKEN = "{prompt}";

/**
 * Headless command lines for each agent. Every agent runs unattended as the owner,
 * so each preset turns off interactive approval prompts.
 */
export const AGENT_PRESETS: Record<BuiltinAgentId, { label: string; command: string }> = {
  pi: { label: "Pi", command: "pi -p {prompt}" },
  claude: {
    label: "Claude Code",
    command: "claude -p {prompt} --permission-mode bypassPermissions",
  },
  // Network stays off: with it on, a sandboxed run could reach this server's loopback API.
  codex: { label: "Codex", command: "codex exec --sandbox workspace-write {prompt}" },
};

export function isBuiltinAgent(value: unknown): value is BuiltinAgentId {
  return typeof value === "string" && (BUILTIN_AGENT_IDS as readonly string[]).includes(value);
}

/** What the UI and reports call an agent: a built-in's label, Pi with its model, or an added agent's name. */
export function agentLabel(id: AgentId): string {
  const model = piModelOf(id);
  if (model) return `Pi · ${model}`;
  return isBuiltinAgent(id) ? AGENT_PRESETS[id].label : id;
}

/**
 * The command line an agent runs: its command in Settings, or for "pi:<alias>" the pi agent's command
 * with the alias right after the program, where Pi's launcher looks for it. Null for an unknown agent.
 */
export function agentCommand(agents: Record<AgentId, { command: string }>, id: AgentId): string | null {
  if (Object.hasOwn(agents, id)) return agents[id]!.command;
  const model = piModelOf(id);
  const pi = agents.pi?.command;
  if (!model || !pi) return null;
  const args = splitCommand(pi);
  const index = args.indexOf(commandProgram(args));
  return [...args.slice(0, index + 1), model, ...args.slice(index + 1)].map(quoteArg).join(" ");
}

/** Quotes an argument for splitCommand, leaving plain words and the prompt token as they are. */
function quoteArg(arg: string): string {
  return /^[\w@%+=:,./{}-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
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

/** Pi itself, or a Pi launcher that passes its arguments on to Pi (`pi-claude`, say). */
function isPiProgram(program: string): boolean {
  return /^pi(-[\w.-]+)?$/.test(path.basename(program));
}

/**
 * Whether a command runs an agent whose sessions pi-jobs can name and resume: Pi, or a launcher named
 * `pi-…`. Pi's `--session-id` opens the session with that ID in the working directory, creating it
 * the first time, so an item's runs, which share a working directory, continue one conversation.
 */
export function supportsSessions(command: string): boolean {
  try {
    return isPiProgram(commandProgram(splitCommand(command)));
  } catch {
    return false;
  }
}

/**
 * Adds the session to an agent's argv when the agent supports sessions: right after the program, or
 * after `pi`'s first argument when that is a word rather than an option, since Pi's launcher reads a
 * model alias (`pi claude -p …`) only as the first argument.
 */
export function withSession(argv: string[], sessionId: string | null): string[] {
  if (!sessionId) return argv;
  const program = commandProgram(argv);
  if (!isPiProgram(program)) return argv;
  let index = argv.indexOf(program);
  const next = argv[index + 1];
  if (path.basename(program) === "pi" && next !== undefined && !next.startsWith("-")) index++;
  return [...argv.slice(0, index + 1), "--session-id", sessionId, ...argv.slice(index + 1)];
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
