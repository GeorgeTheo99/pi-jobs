#!/usr/bin/env node
// pi-jobs CLI: manages API tokens directly in the state database, so access can be bootstrapped
// by whoever has a shell on this machine.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
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
                                                  terminal), so it stays out of ps and history`;

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

async function main(argv: string[]): Promise<number> {
  const [command, sub, ...rest] = argv;
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
  if (command !== "token") {
    console.error(USAGE);
    return 2;
  }
  const config = loadConfig();
  const store = new Store(path.join(config.stateDir, "pi-jobs.db"));
  try {
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
