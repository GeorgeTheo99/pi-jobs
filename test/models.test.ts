import assert from "node:assert/strict";
import { test } from "node:test";
import { PiModels } from "../src/models.ts";

const LISTED = JSON.stringify({
  version: 1,
  models: [
    { alias: "gpt", aliases: [], name: "gpt-5.4", group: "cloud", default: false },
    { alias: "glm53flashfw", aliases: ["glm53flash"], name: "glm-5.3-flash-fw", group: "cloud", default: false },
    { alias: "openai", aliases: [], name: "gpt-6-astra", group: "direct", default: true },
  ],
});

/** A fake `pi` launcher: records each call and answers like pi-shared's (or stock Pi, or without the Claude bridge). */
function fakePi(kind: "launcher" | "stock" | "no-bridge" | "broken" = "launcher") {
  const calls: string[][] = [];
  const exec = async (argv: string[]) => {
    calls.push(argv);
    const args = argv.slice(argv.indexOf("pi") + 1).join(" ");
    if (kind === "stock") return { code: 0, stdout: "pi - AI coding assistant\n\nUsage:\n  pi [options] [@files...] [messages...]\n" };
    if (args === "models --help") return { code: 0, stdout: "Usage: pi models [--local | --cloud | --direct] [--verbose] [--json]\n" };
    if (args === "models --json") return kind === "broken" ? { code: 0, stdout: "not json" } : { code: 0, stdout: LISTED };
    if (args === "claude --version") return { code: kind === "no-bridge" ? 1 : 0, stdout: "1.5.0\n" };
    return { code: 1, stdout: "" };
  };
  return { calls, exec };
}

test("lists Pi's aliases and the Claude bridge from the pi agent's launcher, once per 30 s", async () => {
  const fake = fakePi();
  const models = new PiModels({ env: {}, piCommand: () => "env A=1 pi -p {prompt}", exec: fake.exec });
  const list = await models.list();
  assert.equal(list.error, null);
  assert.deepEqual(list.models.map((m) => `${m.alias}:${m.group}`), ["gpt:cloud", "glm53flashfw:cloud", "openai:direct", "claude:bridge"]);
  assert.equal(list.models.find((m) => m.alias === "openai")!.default, true);
  assert.deepEqual(fake.calls[0], ["env", "A=1", "pi", "models", "--help"], "runs the agent's program, without its options");
  await models.list();
  assert.equal(fake.calls.length, 3, "cached");
  assert.equal(await models.unavailable("gpt"), null);
  assert.equal(await models.unavailable("glm53flash"), null, "other names for an alias count");
  assert.equal(await models.unavailable("claude"), null);
  assert.match((await models.unavailable("gone")) ?? "", /no model alias "gone"/);
});

test("without the Claude bridge, it isn't listed", async () => {
  const list = await new PiModels({ env: {}, piCommand: () => "pi -p {prompt}", exec: fakePi("no-bridge").exec }).list();
  assert.ok(!list.models.some((m) => m.alias === "claude"));
});

test("stock Pi is never asked to list models (it would take them as a prompt)", async () => {
  const fake = fakePi("stock");
  const models = new PiModels({ env: {}, piCommand: () => "pi -p {prompt}", exec: fake.exec });
  const list = await models.list();
  assert.deepEqual(list.models, []);
  assert.match(list.error ?? "", /no model launcher/);
  assert.deepEqual(fake.calls, [["pi", "models", "--help"]]);
  assert.match((await models.unavailable("gpt")) ?? "", /can't be listed/);
});

test("bad output and bad commands are errors, not models", async () => {
  assert.match((await new PiModels({ env: {}, piCommand: () => "pi", exec: fakePi("broken").exec }).list()).error ?? "", /pi models --json/);
  assert.match((await new PiModels({ env: {}, piCommand: () => 'pi "open', exec: fakePi().exec }).list()).error ?? "", /invalid/);
  const other = fakePi();
  const list = await new PiModels({ env: {}, piCommand: () => "node agent.mjs {prompt}", exec: other.exec }).list();
  assert.match(list.error ?? "", /doesn't run pi/);
  assert.deepEqual(other.calls, [], "another program is never run with models arguments");
});
