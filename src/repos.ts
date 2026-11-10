import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Hosting services whose paths never name a directory on this server. */
const PUBLIC_FORGES = new Set(["github.com", "gitlab.com", "bitbucket.org", "codeberg.org", "git.sr.ht", "ssh.dev.azure.com"]);

export interface Checkout {
  path: string;
  remotes: string[];
}

export type Resolution =
  | { status: "found"; path: string }
  | { status: "none" }
  | { status: "ambiguous"; candidates: string[] };

/**
 * Keys that identify a git remote URL independently of its spelling, so a checkout on another
 * machine can be matched to one here. Lowercased, without `.git`.
 *
 * - Network URLs (`https://`, `ssh://`, `user@host:path`) give `host/path` on both sides.
 * - A server checkout whose remote is a local path (`/…`, `~/…`, `file://…`) gives
 *   `path:/absolute/path` on this machine.
 * - A caller's SSH remote also gives `path:…`, resolving a home-relative path against this
 *   machine's home: SSH remotes are assumed to name a path on the server. The caller's own local
 *   paths name its disk, not the server's, so they give no keys.
 *
 * Path keys are one-sided (caller SSH path vs. server local path), so two SSH remotes on
 * different hosts never match each other through their paths.
 */
export function remoteKeys(url: string, side: "caller" | "server", home = os.homedir()): string[] {
  const clean = (value: string) =>
    value
      .trim()
      .replace(/\/+$/, "")
      .replace(/\.git$/i, "")
      .toLowerCase();
  const local = (value: string) => `path:${clean(path.resolve(home, value.replace(/^~(?=$|\/)/, home)))}`;
  const trimmed = url.trim();
  if (!trimmed) return [];

  const localPath =
    trimmed.startsWith("/") || trimmed.startsWith("~")
      ? trimmed
      : trimmed.startsWith("file://")
        ? decodeURIComponent(trimmed.slice("file://".length))
        : null;
  if (localPath !== null) return side === "server" ? [local(localPath)] : [];

  // scp-like syntax: [user@]host:path (no scheme, a colon before the first slash).
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.*)$/.exec(trimmed);
  if (scp && !trimmed.includes("://")) {
    const [, host, rest] = scp as unknown as [string, string, string];
    const network = clean(`${host}/${rest.replace(/^\/+/, "")}`);
    return side === "caller" && !PUBLIC_FORGES.has(host.toLowerCase()) ? [network, local(rest)] : [network];
  }

  const parsed = URL.parse(trimmed);
  if (!parsed?.hostname) return [];
  const urlPath = decodeURIComponent(parsed.pathname);
  const keys = [clean(`${parsed.hostname}/${urlPath.replace(/^\/+/, "")}`)];
  // ssh://host/~/repo and ssh://host/abs/path both name a path on that host.
  if (side === "caller" && parsed.protocol === "ssh:" && !PUBLIC_FORGES.has(parsed.hostname.toLowerCase())) {
    keys.push(local(urlPath.replace(/^\/~(?=\/|$)/, "~")));
  }
  return keys;
}

/** Git checkouts directly under each root, with their remote URLs. */
export async function scanCheckouts(roots: string[]): Promise<Checkout[]> {
  const checkouts: Checkout[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const name of entries.sort()) {
      const dir = path.join(root, name);
      try {
        await stat(path.join(dir, ".git"));
        const { stdout } = await execFileP("git", ["-C", dir, "remote", "-v"]);
        const remotes = [...new Set(stdout.split("\n").map((line) => line.split(/\s+/)[1]).filter(Boolean))] as string[];
        checkouts.push({ path: dir, remotes });
      } catch {
        // Not a git checkout.
      }
    }
  }
  return checkouts;
}

/**
 * The checkout here that shares a remote with the caller's. `name`, the caller's checkout
 * directory name, breaks ties between several checkouts of one repo.
 */
export function resolveCheckout(checkouts: Checkout[], remotes: string[], name?: string): Resolution {
  const wanted = new Set(remotes.flatMap((url) => remoteKeys(url, "caller")));
  const matches = checkouts.filter((c) => c.remotes.some((url) => remoteKeys(url, "server").some((key) => wanted.has(key))));
  if (matches.length === 0) return { status: "none" };
  if (matches.length === 1) return { status: "found", path: matches[0]!.path };
  const named = matches.filter((c) => path.basename(c.path) === name);
  if (named.length === 1) return { status: "found", path: named[0]!.path };
  return { status: "ambiguous", candidates: matches.map((c) => c.path) };
}
