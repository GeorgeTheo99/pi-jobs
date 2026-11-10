import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  host: string;
  port: number;
  stateDir: string;
  uiDir: string;
  /** Host names (without port) the server answers to; guards against DNS rebinding. */
  allowedHosts: string[];
  /** Directories whose child git checkouts can be matched by remote URL. */
  repoRoots: string[];
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.PI_JOBS_HOST ?? "127.0.0.1";
  const extraHosts = (env.PI_JOBS_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return {
    host,
    port: Number(env.PI_JOBS_PORT ?? 8790),
    stateDir: env.PI_JOBS_STATE_DIR ?? path.join(os.homedir(), ".local", "state", "pi-jobs"),
    uiDir: env.PI_JOBS_UI_DIR ?? path.join(repoRoot, "ui", "dist"),
    allowedHosts: ["127.0.0.1", "localhost", "[::1]", host.toLowerCase(), ...extraHosts],
    repoRoots: (env.PI_JOBS_REPO_ROOTS ?? path.join(os.homedir(), "local_code")).split(path.delimiter).filter(Boolean),
  };
}
