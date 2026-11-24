// Stand-in for an agent CLI: `node fake-agent.mjs <mode> <prompt>`.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

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
  case "release":
    // Like a release: a version bump, pushed onto main; what it was told and given goes to the record file.
    writeFileSync(pidFile, JSON.stringify({ prompt, commit: process.env.PI_JOBS_SHIP_COMMIT, branch: process.env.PI_JOBS_SHIP_BRANCH }));
    const version = (existsSync("VERSION") ? Number(readFileSync("VERSION", "utf8")) : 1) + 1;
    writeFileSync("VERSION", `${version}\n`);
    execFileSync("git", ["add", "VERSION"]);
    execFileSync("git", ["-c", "user.name=agent", "-c", "user.email=agent@example.com", "commit", "-qm", `Release ${version}`]);
    execFileSync("git", ["push", "-q", "origin", "HEAD:main"]);
    console.log(`Released\nversion ${version} is on main`);
    break;
  case "rebase-release":
    // Like a release onto a main that moved: rebase (new commit ids), then push.
    execFileSync("git", ["-c", "user.name=agent", "-c", "user.email=agent@example.com", "pull", "-q", "--rebase", "origin", "main"]);
    execFileSync("git", ["push", "-q", "origin", "HEAD:main"]);
    console.log("Released\nrebased onto main and pushed");
    break;
  case "implemented":
    writeFileSync("feature.txt", "done\n");
    console.log("Implemented the feature.\nVerdict: implemented on this branch");
    break;
  case "not-released":
    console.log("**Not released**\nThe tests failed, so I stopped before pushing.");
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
