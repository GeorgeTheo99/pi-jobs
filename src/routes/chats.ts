import { randomUUID } from "node:crypto";
import { applyAction } from "../actions.ts";
import type { Chat } from "../store.ts";
import { HttpError, readChunk, readJson } from "../http.ts";
import { MAX_INSTRUCTIONS } from "../validate.ts";
import type { AppContext, Route } from "./context.ts";

export function chatRoutes(ctx: AppContext): Route[] {
  const { store, chats, findJob } = ctx;
  return [
    ["GET", /^\/api\/chats$/, async () => store.listChats().map((chat) => ({ ...chat, busy: chats.isBusy(chat.id), lastTurn: store.chatTurns(chat.id).at(-1) ?? null }))],
    [
      "POST",
      /^\/api\/chats$/,
      async (req) => {
        const body = await readJson(req);
        const message = chatMessage(body);
        const jobId = body.jobId == null ? null : findJob(String(body.jobId)).id;
        const runId = body.runId == null ? null : (store.getRun(Number(body.runId))?.id ?? null);
        if (body.runId != null && runId === null) throw new HttpError(404, "Run not found");
        const settings = store.getSettings();
        const agent = body.agent == null ? settings.defaultAgent : body.agent;
        if (typeof agent !== "string" || !Object.hasOwn(settings.agents, agent)) throw new HttpError(400, "Fix the highlighted fields", { agent: "Unknown agent" });
        const line = message.split("\n")[0]!.trim();
        const title = line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
        const chat = store.createChat({ title, jobId, runId, agent, sessionId: randomUUID() });
        return sendMessage(chat, message);
      },
    ],
    ["GET", /^\/api\/chats\/(\d+)$/, async (_req, [id]) => chatView(findChat(id))],
    [
      "DELETE",
      /^\/api\/chats\/(\d+)$/,
      async (_req, [id]) => {
        const chat = findChat(id);
        if (chats.isBusy(chat.id)) throw new HttpError(409, "Stop the reply before deleting the chat");
        const turnIds = store.chatTurns(chat.id).map((turn) => turn.id);
        store.deleteChat(chat.id);
        await chats.deleteFiles(chat.id, turnIds);
        return { ok: true };
      },
    ],
    ["POST", /^\/api\/chats\/(\d+)\/messages$/, async (req, [id]) => sendMessage(findChat(id), chatMessage(await readJson(req)))],
    [
      "POST",
      /^\/api\/chats\/(\d+)\/cancel$/,
      async (_req, [id]) => {
        const chat = findChat(id);
        if (!chats.cancel(chat.id)) throw new HttpError(409, "No reply is being written");
        return chatView(chat);
      },
    ],
    [
      "GET",
      /^\/api\/chats\/(\d+)\/turns\/(\d+)\/log$/,
      async (_req, [id, turnId], url) => {
        const turn = store.getTurn(Number(turnId));
        if (!turn || turn.chatId !== findChat(id).id) throw new HttpError(404, "Turn not found");
        const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
        const { text, next, size } = await readChunk(chats.logPath(turn.id), offset);
        return { text, offset: next, size, done: turn.status !== "running" && next >= size };
      },
    ],
    [
      "POST",
      /^\/api\/chats\/(\d+)\/turns\/(\d+)\/actions\/(\d+)$/,
      async (req, [id, turnId, index]) => {
        const chat = findChat(id);
        const turn = store.getTurn(Number(turnId));
        if (!turn || turn.chatId !== chat.id) throw new HttpError(404, "Turn not found");
        const action = turn.actions[Number(index)];
        if (!action) throw new HttpError(404, "Action not found");
        const body = await readJson(req);
        if (body.decision !== "apply" && body.decision !== "dismiss") throw new HttpError(400, 'Send {"decision": "apply"} or {"decision": "dismiss"}');
        if (action.status !== "proposed") throw new HttpError(409, `This action was already ${action.status}`);
        const outcome = body.decision === "apply" ? await applyAction(action, store, ctx.callApi) : { action: { ...action, status: "dismissed" as const } };
        // Re-read: another action of the turn may have been decided meanwhile.
        const actions = store.getTurn(turn.id)!.actions.map((a, i) => (i === Number(index) ? outcome.action : a));
        store.updateTurn(turn.id, { actions });
        store.touchChat(chat.id);
        // A secret goes to the owner's card in this response only: it is never stored or shown to the agent.
        return { action: outcome.action, ...("secret" in outcome && outcome.secret ? { secret: outcome.secret } : {}) };
      },
    ],
  ];

  function findChat(id: string | undefined): Chat {
    const chat = store.getChat(Number(id));
    if (!chat) throw new HttpError(404, "Chat not found");
    return chat;
  }

  function chatView(chat: Chat) {
    return { ...chat, busy: chats.isBusy(chat.id), turns: store.chatTurns(chat.id) };
  }

  function chatMessage(body: Record<string, unknown>): string {
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) throw new HttpError(400, "Fix the highlighted fields", { message: "Write a message" });
    if (message.length > MAX_INSTRUCTIONS) throw new HttpError(400, "Fix the highlighted fields", { message: `Keep it under ${MAX_INSTRUCTIONS} characters` });
    return message;
  }

  function sendMessage(chat: Chat, message: string) {
    chats.send(chat, message);
    return chatView(store.getChat(chat.id)!);
  }
}
