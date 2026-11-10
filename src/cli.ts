#!/usr/bin/env node
// pi-jobs CLI: manages API tokens directly in the state database, so access can be bootstrapped
// by whoever has a shell on this machine.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { loadConfig } from "./config.ts";
import { Store } from "./store.ts";

/** Where Pi's pi-jobs tools look for their server URL and token. */
export const CLIENT_CONFIG = path.join(os.homedir(), ".config", "pi-jobs", "client.json");

const USAGE = `Usage:
  pi-jobs token create <name> [--client-config]   Create a token and print it once.
                                                  --client-config also saves it with this
                                                  server's URL to ${CLIENT_CONFIG}
  pi-jobs token list
  pi-jobs token revoke <name>
  pi-jobs client-config <url>                     Point this machine's Pi tools at a server;
                                                  reads the token from stdin (prompts on a
                                                  terminal), so it stays out of ps and history
  pi-jobs connect-local                           Point this machine's Pi tools at the local
                                                  server, minting a token only when needed
  pi-jobs verify                                  Read-only check: the LaunchAgent is loaded and
                                                  the server answers /api/health`;

function writeClientConfig(url: string, token: string): void {
  mkdirSync(path.dirname(CLIENT_CONFIG), { recursive: true, mode: 0o700 });
  writeFileSync(CLIENT_CONFIG, `${JSON.stringify({ url, token }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(CLIENT_CONFIG, 0o600);
  console.log(`Saved ${CLIENT_CONFIG}`);
}

/** Loopback and Tailscale hosts, where plain HTTP is acceptable; matches the Pi tools' rule. */
function isPrivateLink(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const parts = host.split(".");
  const ip = parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255) ? parts.map(Number) : null;
  return (
    host === "localhost" ||
    host === "::1" ||
    host.endsWith(".ts.net") ||
    /^fd7a:115c:a1e0:/.test(host) ||
    ip?.[0] === 127 ||
    (ip?.[0] === 100 && ip[1]! >= 64 && ip[1]! <= 127)
  );
}

/** Reads one line from stdin; on a terminal, prompts without echoing it. */
async function readSecret(prompt: string): Promise<string> {
  const tty = process.stdin.isTTY;
  const restoreEcho = () => {
    spawnSync("stty", ["echo"], { stdio: "inherit" });
    process.stderr.write("\n");
  };
  // Ctrl-C at the prompt must not leave the terminal without echo.
  const onInterrupt = () => {
    restoreEcho();
    process.exit(130);
  };
  if (tty) {
    process.stderr.write(prompt);
    spawnSync("stty", ["-echo"], { stdio: "inherit" });
    process.once("SIGINT", onInterrupt);
  }
  try {
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) {
      rl.close();
      return line.trim();
    }
    return "";
  } finally {
    if (tty) {
      process.off("SIGINT", onInterrupt);
      restoreEcho();
    }
  }
}

/**
 * Points this machine's Pi tools at the local server. Keeps a client config that already works
 * (a loopback URL with a token this server accepts) or that points at another server.
 */
function connectLocal(store: Store, port: number): number {
  let current: { url?: unknown; token?: unknown } = {};
  if (existsSync(CLIENT_CONFIG)) {
    try {
      current = JSON.parse(readFileSync(CLIENT_CONFIG, "utf8"));
    } catch {
      // Unreadable: replace it below.
    }
  }
  const currentUrl = typeof current.url === "string" ? URL.parse(current.url) : null;
  if (currentUrl && !["127.0.0.1", "localhost", "[::1]"].includes(currentUrl.hostname)) {
    console.log(`Pi tools already use ${current.url}; leaving ${CLIENT_CONFIG} unchanged`);
    return 0;
  }
  if (currentUrl && typeof current.token === "string" && store.authenticate(current.token)) {
    console.log(`Pi tools already use this server (${CLIENT_CONFIG})`);
    return 0;
  }
  const host = os.hostname().replace(/\.local$/i, "").toLowerCase().replace(/[^\w.-]+/g, "-").slice(0, 30) || "local";
  const taken = new Set(store.listTokens().map((t) => t.name));
  let name = `${host}-pi`;
  for (let n = 2; taken.has(name); n++) name = `${host}-pi-${n}`;
  writeClientConfig(`http://127.0.0.1:${port}`, store.createToken(name).secret);
  console.log(`Pi tools now use this server with token "${name}"`);
  return 0;
}

/** Read-only readiness check used by pi-setup's doctor. Prints evidence; exits non-zero on failure. */
async function verify(port: number): Promise<number> {
  const label = "com.local.pi-jobs";
  const loaded = spawnSync("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${label}`], { stdio: "ignore" });
  if (loaded.status !== 0) {
    console.error(`${label} is not loaded; run install.sh in the pi-jobs checkout`);
    return 1;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5000) });
    const health = (await res.json()) as { ok?: boolean; apiVersion?: number; version?: string };
    if (!res.ok || health.ok !== true) throw new Error(`HTTP ${res.status}`);
    console.log(`pi-jobs ${health.version ?? "?"} is loaded and healthy on 127.0.0.1:${port} (API v${health.apiVersion})`);
    return 0;
  } catch (error) {
    console.error(`${label} is loaded but http://127.0.0.1:${port}/api/health failed: ${(error as Error).message}`);
    return 1;
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, sub, ...rest] = argv;
  if (command === "verify" && !sub) return verify(loadConfig().port);
  if (command === "client-config" && sub && rest.length === 0) {
    const url = URL.parse(sub);
    if (!url || !/^https?:$/.test(url.protocol)) {
      console.error(`Not an http(s) URL: ${sub}`);
      return 2;
    }
    if (url.protocol === "http:" && !isPrivateLink(url.hostname)) {
      console.error(`${url.host} is neither loopback nor on the tailnet, so the token would travel unencrypted. Use https.`);
      return 2;
    }
    const token = await readSecret("pi-jobs API token: ");
    if (!/^pjt_[\w-]{20,}$/.test(token)) {
      console.error("That doesn't look like a pi-jobs token (pjt_…)");
      return 1;
    }
    writeClientConfig(sub.replace(/\/+$/, ""), token);
    return 0;
  }
  if (command !== "token" && command !== "connect-local") {
    console.error(USAGE);
    return 2;
  }
  const config = loadConfig();
  const store = new Store(path.join(config.stateDir, "pi-jobs.db"));
  try {
    if (command === "connect-local") return connectLocal(store, config.port);
    if (sub === "list") {
      for (const t of store.listTokens()) console.log(`${t.name}\tcreated ${t.createdAt}\tlast used ${t.lastUsedAt ?? "never"}`);
      return 0;
    }
    const name = rest.find((arg) => !arg.startsWith("--"));
    if (sub === "create" && name) {
      if (store.listTokens().some((t) => t.name === name)) {
        console.error(`A token named "${name}" exists`);
        return 1;
      }
      const { secret } = store.createToken(name);
      if (rest.includes("--client-config")) writeClientConfig(`http://127.0.0.1:${config.port}`, secret);
      else console.log(secret);
      return 0;
    }
    if (sub === "revoke" && name) {
      const token = store.listTokens().find((t) => t.name === name);
      if (!token || !store.deleteToken(token.id)) {
        console.error(`No token named "${name}"`);
        return 1;
      }
      console.log(`Revoked "${name}"`);
      return 0;
    }
    console.error(USAGE);
    return 2;
  } finally {
    store.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
