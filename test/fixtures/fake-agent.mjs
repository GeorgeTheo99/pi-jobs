// Stand-in for an agent CLI: `node fake-agent.mjs <mode> <prompt>`.
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [spec, prompt = ""] = process.argv.slice(2);
const [mode, pidFile] = spec.split(":");

// Leaves a child in the agent's process group that ignores SIGTERM.
function spawnStubbornChild(detached = false) {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    detached,
  });
  writeFileSync(pidFile, String(child.pid));
  child.unref();
}
console.log(`fake agent (${mode}) in ${process.cwd()} run=${process.env.PI_JOBS_RUN_ID}`);

switch (mode) {
  case "edit":
    writeFileSync("agent-output.txt", prompt);
    break;
  case "commit":
    writeFileSync("committed.txt", "by agent\n");
    execFileSync("git", ["add", "committed.txt"]);
    execFileSync("git", ["-c", "user.name=agent", "-c", "user.email=agent@example.com", "commit", "-qm", "agent commit"]);
    break;
  case "fail":
    writeFileSync("partial.txt", "half done\n");
    process.exit(3);
  case "orphan":
    spawnStubbornChild();
    break;
  case "detached":
    // Like Pi's bash tool: a new session, outside the agent's process group.
    spawnStubbornChild(true);
    break;
  case "platform": {
    // A detached platform binary: macOS hides its environment, so only its cwd identifies it.
    const child = spawn("/bin/sleep", ["600"], { stdio: "ignore", detached: true, env: {} });
    writeFileSync(pidFile, String(child.pid));
    child.unref();
    break;
  }
  case "stubborn":
    spawnStubbornChild();
    setTimeout(() => {}, 60_000);
    break;
  case "sleep":
    setTimeout(() => {}, 60_000);
    break;
  default:
    break;
}
