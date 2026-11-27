import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_PRESETS, buildArgv, commandProgram, resolveExecutable, splitCommand } from "../src/agents.ts";
import { cronError, nextRuns } from "../src/scheduler.ts";

test("splitCommand handles quotes and escapes like a shell", () => {
  assert.deepEqual(splitCommand(`pi -p   {prompt}`), ["pi", "-p", "{prompt}"]);
  assert.deepEqual(splitCommand(`a "b c" 'd "e"' f\\ g ""`), ["a", "b c", 'd "e"', "f g", ""]);
  assert.deepEqual(splitCommand(`x "say \\"hi\\""`), ["x", 'say "hi"']);
  assert.throws(() => splitCommand(`a "b`), /Unterminated/);
});

test("buildArgv substitutes or appends the prompt as one argument", () => {
  const prompt = "fix it; rm -rf / && $(echo nope)";
  assert.deepEqual(buildArgv("pi -p {prompt}", prompt), ["pi", "-p", prompt]);
  assert.deepEqual(buildArgv("codex exec", prompt), ["codex", "exec", prompt]);
  assert.throws(() => buildArgv("   ", prompt), /empty/);
  assert.throws(() => buildArgv("{prompt}", prompt), /executable/);
});

test("every preset builds a command", () => {
  for (const { command } of Object.values(AGENT_PRESETS)) {
    assert.ok(buildArgv(command, "PROMPT").includes("PROMPT"));
  }
});

test("commandProgram looks through env assignments", () => {
  assert.equal(commandProgram(["pi", "-p"]), "pi");
  assert.equal(commandProgram(["env", "A=1", "-u", "B", "claude", "-p"]), "claude");
  assert.equal(commandProgram(["/usr/bin/env", "A=1"]), "/usr/bin/env");
});

test("resolveExecutable searches PATH", async () => {
  assert.equal(await resolveExecutable("sh", "/nonexistent:/bin"), "/bin/sh");
  assert.equal(await resolveExecutable("definitely-not-a-binary", "/bin"), null);
});

test("cron validation and preview", () => {
  assert.equal(cronError("0 6 * * *"), null);
  assert.match(cronError("not cron") ?? "", /.+/);
  const [first, second] = nextRuns("*/5 * * * *", 2);
  assert.ok(first && second && Date.parse(second) - Date.parse(first) === 5 * 60_000);
});

test("sessions apply to Pi only, right after the program or its model alias", async () => {
  const { supportsSessions, withSession } = await import("../src/agents.ts");
  assert.equal(supportsSessions("pi -p {prompt}"), true);
  assert.equal(supportsSessions("env A=1 /opt/bin/pi -p {prompt}"), true);
  assert.equal(supportsSessions(AGENT_PRESETS.claude.command), false);
  assert.equal(supportsSessions('pi "unterminated'), false);
  assert.equal(supportsSessions("pi-claude -p {prompt}"), true, "a Pi launcher passes its arguments on to Pi");
  assert.equal(supportsSessions("pipx run x {prompt}"), false);
  assert.deepEqual(withSession(["pi-claude", "-p", "x"], "s1"), ["pi-claude", "--session-id", "s1", "-p", "x"]);
  assert.deepEqual(withSession(["env", "A=1", "pi", "-p", "x"], "s1"), ["env", "A=1", "pi", "--session-id", "s1", "-p", "x"]);
  assert.deepEqual(withSession(["claude", "-p", "x"], "s1"), ["claude", "-p", "x"]);
  assert.deepEqual(withSession(["pi", "-p", "x"], null), ["pi", "-p", "x"]);
  // Pi's launcher reads a model alias only as the first argument, so the session goes after it.
  assert.deepEqual(withSession(["pi", "claude", "-p", "x"], "s1"), ["pi", "claude", "--session-id", "s1", "-p", "x"]);
  assert.deepEqual(withSession(["env", "A=1", "/opt/bin/pi", "gpt", "-p", "x"], "s1"), ["env", "A=1", "/opt/bin/pi", "gpt", "--session-id", "s1", "-p", "x"]);
  assert.deepEqual(withSession(["pi", "-p", "x"], "s1"), ["pi", "--session-id", "s1", "-p", "x"]);
});

test("pi:<alias> agents run the pi agent's command with the alias first", async () => {
  const { agentCommand, agentLabel, piModelOf } = await import("../src/agents.ts");
  const agents = { pi: { command: "pi -p {prompt}" }, claude: { command: "claude -p {prompt}" }, "pi-claude": { command: "pi-claude -p {prompt}" } };
  assert.equal(piModelOf("pi:glm53flash"), "glm53flash");
  assert.equal(piModelOf("pi"), null);
  assert.equal(piModelOf("pi:"), null);
  assert.equal(piModelOf("pi:Bad Alias"), null);
  assert.equal(agentCommand(agents, "pi:claude"), "pi claude -p {prompt}");
  assert.equal(agentCommand(agents, "pi-claude"), "pi-claude -p {prompt}");
  assert.equal(agentCommand(agents, "codex"), null);
  assert.equal(agentCommand(agents, "pi:"), null);
  const wrapped = agentCommand({ pi: { command: `env A='x y' /opt/pi -p {prompt}` } }, "pi:gpt")!;
  assert.deepEqual(splitCommand(wrapped), ["env", "A=x y", "/opt/pi", "gpt", "-p", "{prompt}"], "env assignments and quoting survive");
  assert.equal(agentLabel("pi:gpt"), "Pi · gpt");
  assert.equal(agentLabel("pi"), "Pi");
  assert.equal(agentLabel("pi-claude"), "pi-claude");
});
