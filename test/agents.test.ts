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
