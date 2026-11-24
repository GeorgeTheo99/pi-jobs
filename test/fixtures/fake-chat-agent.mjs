// Stand-in for an agent in a chat: `node fake-chat-agent.mjs <mode> <prompt>`. It saves each prompt in
// its working directory (prompt-1.txt, prompt-2.txt, ...) and replies; a message starting with
// "ACTIONS:" proposes the JSON after it.
import { readdirSync, writeFileSync } from "node:fs";

const [mode, prompt = ""] = process.argv.slice(2);
const count = readdirSync(".").filter((name) => name.startsWith("prompt-")).length;
writeFileSync(`prompt-${count + 1}.txt`, prompt);
const message = prompt.split("\n---\n")[0];
if (mode === "sleep") setTimeout(() => {}, 60_000);
else {
  console.log(`Reply ${count + 1} to: ${message.split("\n")[0]}`);
  if (message.startsWith("ACTIONS:")) console.log(["", "```pi-jobs-actions", message.slice("ACTIONS:".length).trim(), "```"].join("\n"));
  console.error("stderr noise stays out of the reply");
  if (mode === "fail") process.exit(2);
}
