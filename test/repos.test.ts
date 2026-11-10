import assert from "node:assert/strict";
import { test } from "node:test";
import { remoteKeys, resolveCheckout } from "../src/repos.ts";

const HOME = "/Users/server";

test("network URLs normalize to host/path on both sides", () => {
  const github = "github.com/georgetheo99/model-gateway";
  for (const url of [
    "https://github.com/GeorgeTheo99/model-gateway.git",
    "https://github.com/GeorgeTheo99/model-gateway/",
    "git@github.com:GeorgeTheo99/model-gateway.git",
    "ssh://git@github.com/GeorgeTheo99/model-gateway",
  ]) {
    assert.ok(remoteKeys(url, "caller", HOME).includes(github), url);
    assert.ok(remoteKeys(url, "server", HOME).includes(github), url);
  }
  assert.deepEqual(remoteKeys("", "caller", HOME), []);
  assert.deepEqual(remoteKeys("not a url", "caller", HOME), []);
});

test("a caller's SSH remote names a path on the server; local paths are one-sided", () => {
  const bare = "path:/users/server/repos/model-gateway";
  for (const url of [
    "server@studio:repos/model-gateway.git",
    "server@studio:/Users/server/repos/model-gateway.git",
    "ssh://server@studio.example.ts.net/Users/server/repos/model-gateway.git",
    "ssh://server@studio/~/repos/model-gateway.git",
  ]) {
    assert.ok(remoteKeys(url, "caller", HOME).includes(bare), url);
    assert.ok(!remoteKeys(url, "server", HOME).includes(bare), `server-side SSH remotes give no path key: ${url}`);
  }
  for (const url of ["/Users/server/repos/model-gateway.git", "file:///Users/server/repos/model-gateway.git", "~/repos/model-gateway.git"]) {
    assert.deepEqual(remoteKeys(url, "server", HOME), [bare], url);
    assert.deepEqual(remoteKeys(url, "caller", HOME), [], `a caller's local path names its own disk: ${url}`);
  }
});

test("resolveCheckout matches by any shared remote and breaks ties by name", () => {
  const checkouts = [
    { path: "/Users/server/local_code/model-gateway", remotes: ["/Users/server/repos/model-gateway.git", "https://github.com/GeorgeTheo99/model-gateway.git"] },
    { path: "/Users/server/local_code/gt-labs", remotes: ["https://github.com/GeorgeTheo99/gtheolabs.git"] },
    { path: "/Users/server/local_code/gt-labs-staging", remotes: ["https://github.com/GeorgeTheo99/gtheolabs.git"] },
  ];
  const remote = (url: string) => resolveCheckout(checkouts, [url]);
  // Absolute SSH paths, since resolveCheckout resolves home-relative ones against the real home.
  assert.deepEqual(remote("server@studio:/Users/server/repos/model-gateway.git"), { status: "found", path: checkouts[0]!.path });
  assert.deepEqual(remote("git@github.com:GeorgeTheo99/model-gateway.git"), { status: "found", path: checkouts[0]!.path });
  assert.deepEqual(remote("https://github.com/x/y"), { status: "none" });
  assert.equal(remote("git@github.com:GeorgeTheo99/gtheolabs.git").status, "ambiguous");
  assert.deepEqual(resolveCheckout(checkouts, ["git@github.com:GeorgeTheo99/gtheolabs.git"], "gt-labs-staging"), {
    status: "found",
    path: checkouts[2]!.path,
  });
});

test("the same path on different hosts is not the same repository", () => {
  const tools = [{ path: "/x/tools", remotes: ["git@gitlab.com:alice/tools"] }];
  assert.deepEqual(resolveCheckout(tools, ["git@github.com:alice/tools"]), { status: "none" });
  // A forge path never names a directory here, even one that happens to exist.
  const homeBare = [{ path: "/x/tools", remotes: [`${process.env.HOME}/alice/tools.git`] }];
  assert.deepEqual(resolveCheckout(homeBare, ["git@github.com:alice/tools"]), { status: "none" });
  const srv = [{ path: "/x/r", remotes: ["ssh://git@b.example/srv/r"] }];
  assert.deepEqual(resolveCheckout(srv, ["ssh://git@a.example/srv/r"]), { status: "none" });
});
