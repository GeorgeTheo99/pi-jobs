import { randomBytes, timingSafeEqual } from "node:crypto";
import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_LOG_CHUNK = 256 * 1024;

/** An error the API reports with its status, and per-field messages for forms. */
export class HttpError extends Error {
  readonly status: number;
  readonly fields?: Record<string, string>;
  constructor(status: number, message: string, fields?: Record<string, string>) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse((await readBody(req)) || "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
  }
  throw new HttpError(400, "Expected a JSON object");
}

export async function readChunk(file: string, offset: number) {
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    return { text: "", next: 0, size: 0 };
  }
  try {
    const { size } = await handle.stat();
    const start = Math.min(offset, size);
    const length = Math.min(size - start, MAX_LOG_CHUNK);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    // Stop at the last complete line so multi-byte characters are never split.
    const end = start + length < size ? buffer.lastIndexOf(0x0a) + 1 || length : length;
    return { text: buffer.subarray(0, end).toString("utf8"), next: start + end, size };
  } finally {
    await handle.close();
  }
}

/** The path prefix a reverse proxy mounted the app under, e.g. "/pi-jobs"; "" when served directly. */
export function proxyPrefix(req: IncomingMessage): string {
  const value = req.headers["x-forwarded-prefix"];
  // Restrictive charset: the value is written into HTML.
  return typeof value === "string" && /^(\/[A-Za-z0-9._-]+)+$/.test(value) ? value : "";
}

export function intParam(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new HttpError(400, `${name} must be an integer`);
  return number;
}

export function prettyPayload(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();
  const custom = req.headers["x-pi-jobs-token"];
  return typeof custom === "string" ? custom : null;
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}
