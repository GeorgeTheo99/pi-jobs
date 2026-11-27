import { execFile } from "node:child_process";
import path from "node:path";
import { commandProgram, splitCommand } from "./agents.ts";

/** One of Pi's model aliases, as `pi models --json` lists it (plus the Claude bridge, `pi claude`). */
export interface PiModel {
  alias: string;
  /** Other names the launcher accepts for it. */
  aliases: string[];
  name: string;
  /** "local", "cloud" or "direct" from `pi models`; "bridge" for `pi claude`. */
  group: string;
  /** The model plain `pi` uses. */
  default: boolean;
}

export interface PiModelList {
  models: PiModel[];
  /** Why there is no list: Pi without pi-shared's launcher, say. Plain `pi` still runs. */
  error: string | null;
}

const PROBE_TIMEOUT_MS = 20_000;
const CACHE_MS = 30_000;

type Exec = (argv: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string }>;

const exec: Exec = (argv, env) =>
  new Promise((resolve) => {
    const child = execFile(argv[0]!, argv.slice(1), { env, timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout) });
    });
    child.stdin?.end();
  });

/**
 * Pi's model aliases, read live from the launcher on this server, so jobs and chats can pick any of
 * them as "pi:<alias>". Never runs a model: `pi models --help` first tells pi-shared's launcher
 * (which lists aliases offline) from stock Pi (which would take "models" as a prompt).
 */
export class PiModels {
  private cached: { at: number; list: Promise<PiModelList> } | null = null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly piCommand: () => string;
  private readonly run: Exec;

  constructor(options: { env: NodeJS.ProcessEnv; piCommand: () => string; exec?: Exec }) {
    this.env = options.env;
    this.piCommand = options.piCommand;
    this.run = options.exec ?? exec;
  }

  list(): Promise<PiModelList> {
    if (!this.cached || Date.now() - this.cached.at > CACHE_MS) this.cached = { at: Date.now(), list: this.read() };
    return this.cached.list;
  }

  /** Why "pi:<alias>" can't run now, or null when Pi's launcher has that alias. */
  async unavailable(alias: string): Promise<string | null> {
    const { models, error } = await this.list();
    if (error) return `Pi's models can't be listed (${error}), so "pi:${alias}" can't be checked`;
    if (models.some((m) => m.alias === alias || m.aliases.includes(alias))) return null;
    return `Pi has no model alias "${alias}" (see pi models)`;
  }

  private async read(): Promise<PiModelList> {
    let pi: string[];
    try {
      const args = splitCommand(this.piCommand());
      // The program and anything before it (`env VAR=value …`), without the pi agent's own options.
      pi = args.slice(0, args.indexOf(commandProgram(args)) + 1);
    } catch (error) {
      return { models: [], error: `the pi agent's command is invalid: ${error instanceof Error ? error.message : String(error)}` };
    }
    // Only Pi's own launcher has models: another program (`node x.mjs …`) must never get "models" as an argument.
    if (pi.length === 0 || path.basename(pi.at(-1)!) !== "pi") return { models: [], error: "the pi agent's command doesn't run pi" };
    const help = await this.run([...pi, "models", "--help"], this.env);
    if (help.code !== 0 || !help.stdout.includes("Usage: pi models") || !help.stdout.includes("--json")) {
      return { models: [], error: "this Pi has no model launcher (pi-shared's pi models)" };
    }
    const listed = await this.run([...pi, "models", "--json"], this.env);
    if (listed.code !== 0) return { models: [], error: `pi models --json exited with code ${listed.code}` };
    let models: PiModel[];
    try {
      const parsed = JSON.parse(listed.stdout) as { version?: unknown; models?: unknown };
      if (parsed.version !== 1 || !Array.isArray(parsed.models)) throw new Error("unexpected format");
      models = parsed.models.flatMap((entry: Record<string, unknown>) =>
        typeof entry?.alias === "string"
          ? [{
              alias: entry.alias,
              aliases: Array.isArray(entry.aliases) ? entry.aliases.filter((a): a is string => typeof a === "string") : [],
              name: typeof entry.name === "string" ? entry.name : entry.alias,
              group: typeof entry.group === "string" ? entry.group : "other",
              default: entry.default === true,
            }]
          : [],
      );
    } catch (error) {
      return { models: [], error: `pi models --json: ${error instanceof Error ? error.message : String(error)}` };
    }
    // The Claude bridge is a launcher shortcut `pi models` doesn't list; `--version` checks it offline.
    if (!models.some((m) => m.alias === "claude") && (await this.run([...pi, "claude", "--version"], this.env)).code === 0) {
      models.push({ alias: "claude", aliases: [], name: "Claude Code bridge", group: "bridge", default: false });
    }
    return { models, error: null };
  }
}
