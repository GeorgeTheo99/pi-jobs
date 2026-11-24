import os from "node:os";
import path from "node:path";
import { AGENT_ID_PATTERN, BUILTIN_AGENT_IDS, buildArgv, isBuiltinAgent } from "./agents.ts";
import { isGitRepo, resolvesToCommit } from "./git.ts";
import { HttpError } from "./http.ts";
import { cronError } from "./scheduler.ts";
import { jobBody } from "./actions.ts";
import { DEFAULT_RETRIES, MAX_RETRIES, type Job, type JobInput, type Settings } from "./store.ts";

/** The longest instructions, messages and release instructions the API takes. */
export const MAX_INSTRUCTIONS = 20_000;

/**
 * Builds a job from a request body. For an update, every field the body leaves out keeps the job's
 * value, so PUT and PATCH both change only what they send.
 */
export async function validateJob(request: Record<string, unknown>, settings: Settings, existing: Job | null = null): Promise<JobInput> {
  const sent = Object.fromEntries(Object.entries(request).filter(([, value]) => value !== undefined));
  const body: Record<string, unknown> = existing ? { ...jobBody(existing), ...sent } : sent;
  const fields: Record<string, string> = {};
  const text = (key: string) => (typeof body[key] === "string" ? (body[key] as string).trim() : "");

  const name = text("name");
  if (!name) fields.name = "Name is required";
  else if (name.length > 80) fields.name = "Keep the name under 80 characters";

  const repoPath = text("repoPath").replace(/^~(?=$|\/)/, os.homedir());
  if (!path.isAbsolute(repoPath)) fields.repoPath = "Use an absolute path to a git repository";
  else if (!(await isGitRepo(repoPath))) fields.repoPath = "Not a git repository";

  const baseRef = text("baseRef") || "HEAD";
  if (!fields.repoPath && !(await resolvesToCommit(repoPath, baseRef))) {
    fields.baseRef = `"${baseRef}" does not resolve to a commit in this repository`;
  }

  const prompt = text("prompt");
  if (!prompt) fields.prompt = "Tell the agent what to do";

  const agent = body.agent ?? null;
  // A job keeps an agent that was since removed from Settings until it is changed; its runs say so.
  if (agent !== null && (typeof agent !== "string" || (!Object.hasOwn(settings.agents, agent) && agent !== existing?.agent))) {
    fields.agent = `Choose one of ${Object.keys(settings.agents).join(", ")}, or the default`;
  }

  const schedule = text("schedule") || null;
  const scheduleError = schedule ? cronError(schedule) : null;
  if (scheduleError) fields.schedule = scheduleError;

  const timeoutMinutes = Number(body.timeoutMinutes ?? 30);
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 1440) {
    fields.timeoutMinutes = "Use a whole number of minutes from 1 to 1440";
  }

  const watchCommand = text("watchCommand") || null;
  if (watchCommand && watchCommand.length > 4000) fields.watchCommand = "Keep the watch command under 4,000 characters";

  const shipCommand = text("shipCommand") || null;
  if (shipCommand && shipCommand.length > 4000) fields.shipCommand = "Keep the release script under 4,000 characters";

  const releaseInstructions = text("releaseInstructions") || null;
  if (releaseInstructions && releaseInstructions.length > MAX_INSTRUCTIONS) {
    fields.releaseInstructions = `Keep the release instructions under ${MAX_INSTRUCTIONS.toLocaleString("en-US")} characters`;
  }
  if (releaseInstructions && shipCommand) {
    fields.releaseInstructions = "Use release instructions or a release script, not both (the instructions can say to run the script)";
  }
  const verifyCommand = text("verifyCommand") || null;
  if (verifyCommand && verifyCommand.length > 4000) fields.verifyCommand = "Keep the verify command under 4,000 characters";
  if (verifyCommand && !releaseInstructions && !shipCommand) fields.verifyCommand = "Add release instructions or a release script first";

  const checkCommand = text("checkCommand") || null;
  const autoRelease = body.autoRelease === true;
  if (autoRelease && !releaseInstructions && !shipCommand) fields.autoRelease = "Add release instructions or a release script first";
  // Without a check, "succeeded" means only that the agent exited 0: too little to release on.
  else if (autoRelease && !checkCommand) fields.autoRelease = "Add a check command first: automatic releases need a passing check";

  const retries = Number(body.retries ?? DEFAULT_RETRIES);
  if (!Number.isInteger(retries) || retries < 0 || retries > MAX_RETRIES) {
    fields.retries = `Use a whole number from 0 to ${MAX_RETRIES}`;
  }

  if (Object.keys(fields).length > 0) throw new HttpError(400, "Fix the highlighted fields", fields);
  return {
    name,
    repoPath,
    baseRef,
    prompt,
    agent: agent as JobInput["agent"],
    schedule,
    timeoutMinutes,
    checkCommand,
    pushBranch: body.pushBranch === true,
    catchUp: body.catchUp !== false,
    retries,
    watchCommand,
    approveRuns: body.approveRuns === true,
    shipCommand,
    releaseInstructions,
    verifyCommand,
    autoRelease,
    enabled: body.enabled !== false,
  };
}

/**
 * Settings from a request body. The built-in agents are always there; others are added by naming them
 * and removed by leaving them out, unless a job still uses them.
 */
export function validateSettings(body: Record<string, unknown>, current: Settings, jobs: Job[]): Settings {
  const fields: Record<string, string> = {};
  const agentsBody = body.agents && typeof body.agents === "object" && !Array.isArray(body.agents) ? (body.agents as Record<string, unknown>) : {};
  const agents: Settings["agents"] = {};
  const ids = [...BUILTIN_AGENT_IDS, ...Object.keys(agentsBody).filter((id) => !isBuiltinAgent(id))];
  for (const id of ids) {
    if (!AGENT_ID_PATTERN.test(id)) {
      fields[`agents.${id}`] = "Name it with lowercase letters, digits and dashes (up to 32), starting with a letter";
      continue;
    }
    const entry = agentsBody[id] as { command?: unknown } | undefined;
    const command = typeof entry?.command === "string" ? entry.command.trim() : "";
    try {
      buildArgv(command, "");
    } catch (error) {
      fields[`agents.${id}`] = error instanceof Error ? error.message : "Invalid command";
    }
    agents[id] = { command };
  }
  for (const job of jobs) {
    if (job.agent && Object.hasOwn(current.agents, job.agent) && !Object.hasOwn(agents, job.agent)) {
      fields[`agents.${job.agent}`] = `Job #${job.id} "${job.name}" uses this agent; change its agent first`;
    }
  }
  if (typeof body.defaultAgent !== "string" || !Object.hasOwn(agents, body.defaultAgent)) fields.defaultAgent = "Choose one of the agents";
  const maxConcurrent = Number(body.maxConcurrent);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) {
    fields.maxConcurrent = "Use a whole number from 1 to 8";
  }
  // Clients from before notifications leave these out and keep them.
  const optional = (key: "notifyCommand" | "publicUrl") =>
    body[key] === undefined ? current[key] : typeof body[key] === "string" ? (body[key] as string).trim() || null : null;
  const notifyCommand = optional("notifyCommand");
  if (notifyCommand && notifyCommand.length > 4000) fields.notifyCommand = "Keep the notify command under 4,000 characters";
  const publicUrl = optional("publicUrl")?.replace(/\/+$/, "") ?? null;
  if (publicUrl && !/^https?:\/\/[^\s]+$/.test(publicUrl)) fields.publicUrl = "Use an http:// or https:// address";
  if (Object.keys(fields).length > 0) throw new HttpError(400, "Fix the highlighted fields", fields);
  return { defaultAgent: body.defaultAgent as string, agents, maxConcurrent, notifyCommand, publicUrl };
}

