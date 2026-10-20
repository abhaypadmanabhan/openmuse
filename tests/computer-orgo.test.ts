import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ComputerService, computerIdentity } from "../apps/server/src/computer.ts";
import {
  OrgoDesktopComputer,
  type OrgoDriver,
  type OrgoInfo,
  type OrgoInput,
  orgoCommand,
  orgoDriver,
  orgoSplit,
} from "../apps/server/src/computer-orgo.ts";
import { computerInstructions, computerTools } from "../apps/server/src/computer-tools.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { ComputerCommand } from "../packages/domain/src/computer.ts";
import { config as base } from "./helpers/computer.ts";

const config: Config = {
  ...base,
  computerProvider: "orgo",
  orgoApiKey: "orgo-test-key-never-sent",
  orgoWorkspaceId: "ws-1",
};
const labels = computerIdentity(config, "owner").labels;
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

// In-memory stand-in for the Orgo REST API. `bash` really runs the command in a local
// shell, so the in-box wrapper's quoting, stdin and stream splitting are exercised.
function fake(
  options: {
    bash?: (command: string) => { output: string; exitCode: number } | undefined;
    inputFails?: boolean;
    screenshotFails?: boolean;
    autoStopFails?: boolean;
  } = {},
) {
  const computers = new Map<string, OrgoInfo>();
  const calls = {
    create: [] as string[],
    start: [] as string[],
    stop: [] as string[],
    autoStop: [] as { id: string; minutes: number }[],
    bash: [] as { command: string; timeout: number }[],
    uploads: [] as { directory: string; filename: string; bytes: number }[],
    screenshots: 0,
    inputs: [] as { action: OrgoInput; body: Record<string, unknown> }[],
  };
  const add = (info: Partial<OrgoInfo>) => {
    const id = info.id ?? `cmp-${computers.size + 1}`;
    computers.set(id, { id, name: "", status: "running", ...info });
    return id;
  };
  const driver: OrgoDriver = {
    async find(name) {
      return [...computers.values()].find((item) => item.name === name);
    },
    async create(name) {
      calls.create.push(name);
      return add({ name });
    },
    async start(id) {
      calls.start.push(id);
      (computers.get(id) as OrgoInfo).status = "running";
    },
    async stop(id) {
      calls.stop.push(id);
      (computers.get(id) as OrgoInfo).status = "frozen";
    },
    async autoStop(id, minutes) {
      calls.autoStop.push({ id, minutes });
      if (options.autoStopFails) throw new Error("plan does not allow auto-stop");
    },
    async bash(_id, command, timeout) {
      calls.bash.push({ command, timeout });
      const scripted = options.bash?.(command);
      if (scripted) return scripted;
      if (command.startsWith("mkdir -p /workspace")) return { output: "", exitCode: 0 };
      // The test host has no /workspace.
      const local = command.includes("missing-dir")
        ? command
        : command.replaceAll("/workspace", "/tmp");
      const run = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", local], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      return { output: run.stdout + run.stderr, exitCode: run.status ?? -1 };
    },
    async upload(_id, directory, filename, data) {
      calls.uploads.push({ directory, filename, bytes: data.length });
      // The wrapper reads parts from its fixed inbox, so mirror them there.
      if (directory === "/tmp/openmuse-in") {
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, filename), data);
      }
    },
    async screenshot() {
      calls.screenshots++;
      if (options.screenshotFails) throw new Error("screenshot failed");
      return jpeg;
    },
    async input(_id, action, body) {
      calls.inputs.push({ action, body });
      if (options.inputFails) throw new Error("connection reset");
    },
  };
  return { driver, calls, computers };
}

let db: Store;
let owners = 0;
before(async () => {
  config.dataDir = await mkdtemp(join(tmpdir(), "openmuse-orgo-test-"));
  db = await createStore();
});
after(async () => {
  await db.close();
  await rm(config.dataDir, { recursive: true, force: true });
});
// Each test gets a fresh owner so leases and receipts never leak between tests.
function service(f: ReturnType<typeof fake>, preload?: Partial<OrgoInfo>) {
  const owner = `owner-${++owners}`;
  const ownerLabels = computerIdentity(config, owner).labels;
  const name = `openmuse-${ownerLabels["dev.openmuse.deployment"]}-${ownerLabels["dev.openmuse.owner"]}`;
  if (preload) f.computers.set("pre", { id: "pre", name, status: "running", ...preload });
  const desktop = new OrgoDesktopComputer(config, f.driver);
  return {
    owner,
    name,
    labels: ownerLabels,
    desktop,
    computer: new ComputerService(db, config, undefined, desktop),
  };
}

test("start creates one computer per owner, sets auto-stop and prepares /workspace", async () => {
  const f = fake();
  const { computer, owner, name } = service(f);
  assert.equal((await computer.snapshot(owner)).status, "stopped");
  assert.equal((await computer.start(owner)).provider, "orgo");
  assert.deepEqual(f.calls.create, [name]);
  assert.deepEqual(f.calls.autoStop, [{ id: "cmp-1", minutes: 15 }]);
  assert.match(f.calls.bash[0].command, /^mkdir -p \/workspace \/opt\/openmuse$/);
  assert.deepEqual(
    f.calls.uploads.map((u) => [u.directory, u.filename]),
    [["/opt/openmuse", "files.py"]],
  );
  assert.equal((await computer.snapshot(owner)).status, "running");
  // A second start finds the computer by name instead of creating another.
  await computer.start(owner);
  assert.equal(f.calls.create.length, 1);
  assert.equal(f.calls.start.length, 0);
});

test("a frozen computer reports stopped and start boots it without creating another", async () => {
  const f = fake();
  const { computer, owner } = service(f, { status: "frozen" });
  assert.equal((await computer.snapshot(owner)).status, "stopped");
  await computer.start(owner);
  assert.deepEqual(f.calls.start, ["pre"]);
  assert.equal(f.calls.create.length, 0);
  assert.equal((await computer.snapshot(owner)).status, "running");
});

test("stop freezes only a running computer; suspended counts as running", async () => {
  const f = fake();
  const { computer, owner, desktop, labels: own } = service(f, { status: "suspended" });
  assert.equal(await desktop.state(own), "running");
  await computer.stop(owner);
  assert.deepEqual(f.calls.stop, ["pre"]);
  assert.equal(await desktop.state(own), "stopped");
  await computer.stop(owner);
  assert.equal(f.calls.stop.length, 1);
});

test("auto-stop is best effort: a plan without it still starts", async () => {
  const f = fake({ autoStopFails: true });
  const { computer, owner } = service(f);
  assert.equal((await computer.start(owner)).status, "running");
});

test("a computer in an error state is refused, and driver failures surface as the app's 503", async () => {
  const f = fake();
  const failing = service(f, { status: "error" });
  await assert.rejects(failing.desktop.inspect(failing.labels), { status: 502 });
  const broken = new OrgoDesktopComputer(config, {
    ...f.driver,
    find: async () => {
      throw new Error("network down");
    },
  });
  await assert.rejects(broken.inspect(labels), (error: Error) => {
    assert.match(error.message, /ORGO_API_KEY/);
    assert.equal((error as { status?: number }).status, 503);
    return true;
  });
});

test("the wrapper separates stdout, stderr and the exit code, and keeps quoting", async () => {
  const f = fake();
  const { computer, owner } = service(f, {});
  const command = "printf '$HOME'; echo \"it's\" >&2; exit 3; $(touch /x); touch /y #";
  const result = await computer.execute(owner, { command });
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, "$HOME");
  assert.equal(result.stderr, "it's\n");
  assert.equal(f.calls.bash.at(-1)?.timeout, 35);
});

test("a missing working directory fails the command with exit 126", async () => {
  const f = fake();
  const { computer, owner } = service(f, {});
  const result = await computer.execute(owner, { command: "pwd", cwd: "/workspace/missing-dir" });
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 126);
  assert.match(result.stderr, /working directory does not exist/);
});

test("Orgo's -1 is timed_out", async () => {
  const f = fake({
    bash: (command) =>
      command.includes("sleep-forever") ? { output: "", exitCode: -1 } : undefined,
  });
  const { computer, owner } = service(f, {});
  assert.equal((await computer.execute(owner, { command: "sleep-forever" })).status, "timed_out");
});

test("a lost response is interrupted and says the outcome is unknown", async () => {
  const f = fake({
    bash: () => {
      throw new Error("socket hang up");
    },
  });
  const { computer, owner } = service(f, {});
  const result = await computer.execute(owner, { command: "echo hi" });
  assert.equal(result.status, "interrupted");
  assert.match(result.stderr, /outcome is unknown/);
});

test("nothing runs after an abort that fired before the command started", async () => {
  const f = fake();
  const { computer, owner } = service(f, {});
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    computer.execute(owner, { command: "echo hi" }, { signal: aborted.signal }),
    /interrupted before execution/,
  );
  assert.equal(f.calls.bash.length, 0);
});

test("output is capped like Docker, stdout first", async () => {
  const f = fake();
  const { computer, owner } = service(f, {});
  const result = await computer.execute(owner, {
    command: "head -c 300000 /dev/zero | tr '\\0' x",
  });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 128 * 1024);
});

test("the wrapper's marker only splits at its own token", () => {
  const token = "openmuse-abc";
  assert.deepEqual(orgoSplit(`out\n${token}\nerr`, token), { stdout: "out", stderr: "err" });
  // Output that merely contains another marker-looking line stays in stdout.
  assert.deepEqual(orgoSplit("a\nopenmuse-zzz\nb", token), {
    stdout: "a\nopenmuse-zzz\nb",
    stderr: "",
  });
  assert.match(orgoCommand("echo hi", token, undefined, 10), /^\/bin\/bash --noprofile --norc -c /);
});

test("file operations send their request as uploaded parts, never in argv", async () => {
  const f = fake();
  // 8 MB plus a little crosses the part boundary, and a multibyte character straddles it.
  const input = `${"a".repeat(8 * 1024 * 1024 - 1)}✓${"b".repeat(1024)}`;
  const { desktop, labels: own } = service(f, {});
  const result = await desktop.run(
    own,
    "python3 -c 'import sys; d = sys.stdin.buffer.read().decode(); print(len(d), d[8*1024*1024-1])'",
    { input, timeoutMs: 20000 },
  );
  assert.equal(result.stdout.trim(), `${8 * 1024 * 1024 + 1024} ✓`);
  const sent = f.calls.uploads.filter((u) => u.directory === "/tmp/openmuse-in");
  assert.equal(sent.length, 2);
  assert.match(sent[0].filename, /\.0000$/);
  assert.match(sent[1].filename, /\.0001$/);
  assert.ok(sent.every((u) => u.bytes <= 8 * 1024 * 1024));
  assert.ok(f.calls.bash.every((call) => Buffer.byteLength(call.command) < 100_000));
  // The inbox is emptied after the command.
  for (const part of sent) assert.equal(existsSync(join(part.directory, part.filename)), false);
});

test("a stopped computer is never resumed by a command, file operation or action", async () => {
  const f = fake();
  const { computer, owner } = service(f, { status: "frozen" });
  await assert.rejects(computer.execute(owner, { command: "echo hi" }), { status: 409 });
  await assert.rejects(computer.desktopAction(owner, { action: "screenshot" }), { status: 409 });
  assert.equal(f.calls.start.length, 0);
  assert.equal(f.calls.bash.length, 0);
});

test("each desktop action maps to one Orgo call and a screenshot", async () => {
  const f = fake();
  const { computer, owner } = service(f, {});
  const run = (action: Record<string, unknown>) => computer.desktopAction(owner, action);
  const shot = await run({ action: "left_click", coordinate: [640, 400] });
  assert.equal(shot.mimeType, "image/jpeg");
  assert.equal(shot.data, Buffer.from(jpeg).toString("base64"));
  assert.equal(shot.receipt.command, "desktop left_click (640, 400)");
  await run({ action: "right_click", coordinate: [1, 2] });
  await run({ action: "double_click", coordinate: [3, 4] });
  await run({ action: "mouse_move", coordinate: [5, 6] });
  await run({ action: "type", text: "hello" });
  await run({ action: "key", text: "ctrl+l Return" });
  await run({ action: "scroll", coordinate: [7, 8], scroll_direction: "up", scroll_amount: 5 });
  await run({ action: "screenshot" });
  assert.deepEqual(f.calls.inputs, [
    { action: "click", body: { x: 640, y: 400 } },
    { action: "click", body: { x: 1, y: 2, button: "right" } },
    { action: "click", body: { x: 3, y: 4, double: true } },
    { action: "mouse-move", body: { x: 5, y: 6 } },
    { action: "type", body: { text: "hello" } },
    { action: "key", body: { key: "ctrl+l" } },
    { action: "key", body: { key: "Return" } },
    { action: "scroll", body: { x: 7, y: 8, direction: "up", amount: 5 } },
  ]);
  assert.equal(f.calls.screenshots, 8);
  assert.deepEqual((await computer.latestScreenshot(owner)).bytes, Buffer.from(jpeg));
});

test("sideways scroll and a click at the pointer fall back to xdotool on the boot screen", async () => {
  const f = fake({
    bash: (command) =>
      command.startsWith("DISPLAY=:99 xdotool") ? { output: "", exitCode: 0 } : undefined,
  });
  const { computer, owner } = service(f, {});
  await computer.desktopAction(owner, { action: "left_click" });
  await computer.desktopAction(owner, {
    action: "scroll",
    coordinate: [10, 20],
    scroll_direction: "right",
  });
  assert.deepEqual(f.calls.inputs, []);
  assert.deepEqual(
    f.calls.bash.map((call) => call.command),
    [
      "DISPLAY=:99 xdotool click 1",
      "DISPLAY=:99 xdotool mousemove --sync 10 20 click --repeat 3 7",
    ],
  );
});

test("a lost input response is an uncertain receipt, and a failed screenshot keeps the input succeeded", async () => {
  const lost = fake({ inputFails: true });
  const a = service(lost, {});
  const uncertain = await a.computer.desktopAction(a.owner, { action: "key", text: "Return" });
  assert.equal(uncertain.receipt.status, "interrupted");
  assert.match(uncertain.warning ?? "", /outcome is unknown/);
  const noShot = fake({ screenshotFails: true });
  const b = service(noShot, {});
  const delivered = await b.computer.desktopAction(b.owner, { action: "type", text: "x" });
  assert.equal(delivered.receipt.status, "succeeded");
  assert.match(delivered.warning ?? "", /screenshot could not be taken/);
  await assert.rejects(b.computer.desktopAction(b.owner, { action: "screenshot" }), {
    status: 503,
  });
});

test("the live view is not offered, and says so", async () => {
  const f = fake();
  const { computer, owner } = service(f, {});
  await assert.rejects(computer.desktopUrl(owner), {
    status: 503,
    message: /no embeddable live view/,
  });
});

test("receipts are kept apart from Docker and E2B receipts", async () => {
  const f = fake();
  const { computer, owner } = service(f, {});
  await computer.execute(owner, { command: "echo hi" });
  assert.equal((await computer.snapshot(owner)).commands.length, 1);
  assert.equal((await db.list<ComputerCommand>(owner, "computer-orgo-commands")).length, 1);
  assert.equal((await db.list<ComputerCommand>(owner, "computer-desktop-commands")).length, 0);
});

test("the agent sees use_desktop, and instructions describe the Orgo image without naming it", () => {
  const f = fake();
  const { computer, owner } = service(f, {});
  const files = {} as Parameters<typeof computerTools>[1];
  const names = computerTools(computer, files, owner, "scope").map((tool) => tool.name);
  assert.ok(names.includes("use_desktop"));
  const instructions = computerInstructions("orgo");
  assert.match(instructions, /use_desktop/);
  assert.match(instructions, /Google Chrome/);
  assert.doesNotMatch(instructions, /Firefox|Xfce|Desktop tab|Orgo|E2B|Docker/);
});

test("the REST driver sends the documented requests with the key as a bearer token", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const respond = (url: string): Response => {
    if (url.endsWith("/workspaces/ws-1"))
      return Response.json({ desktops: [{ id: "c1", name: "n1", status: "running" }] });
    if (url.endsWith("/computers")) return Response.json({ id: "c2" });
    if (url.includes("/screenshot")) return new Response(jpeg);
    if (url.endsWith("/bash")) return Response.json({ output: "hi\n", exit_code: 0 });
    return Response.json({ success: true });
  };
  const driver = orgoDriver(
    { ...config, orgoBaseUrl: "https://orgo.test/api/" },
    async (url, init) => {
      seen.push({ url: String(url), init: init ?? {} });
      return respond(String(url));
    },
  );
  assert.deepEqual(await driver.find("n1"), { id: "c1", name: "n1", status: "running" });
  assert.equal(await driver.find("other"), undefined);
  assert.equal(await driver.create("n2"), "c2");
  assert.deepEqual(await driver.bash("c1", "echo hi", 12), { output: "hi\n", exitCode: 0 });
  await driver.start("c1");
  await driver.stop("c1");
  await driver.autoStop("c1", 15);
  await driver.input("c1", "click", { x: 1, y: 2 });
  assert.deepEqual([...(await driver.screenshot("c1"))], [...jpeg]);
  await driver.upload("c1", "/opt/openmuse", "files.py", Buffer.from("x"));
  const calls = seen.map(
    (call) => `${call.init.method ?? "GET"} ${call.url.replace("https://orgo.test/api", "")}`,
  );
  assert.deepEqual(calls, [
    "GET /workspaces/ws-1",
    "GET /workspaces/ws-1",
    "POST /computers",
    "POST /computers/c1/bash",
    "POST /computers/c1/start",
    "POST /computers/c1/stop",
    "PATCH /computers/c1/resize",
    "POST /computers/c1/click",
    "GET /computers/c1/screenshot?response_format=binary&format=jpeg&quality=80",
    "POST /files/upload",
  ]);
  assert.ok(
    seen.every(
      (call) =>
        (call.init.headers as Record<string, string>).Authorization ===
        "Bearer orgo-test-key-never-sent",
    ),
  );
  assert.deepEqual(JSON.parse(String(seen[2].init.body)), {
    workspace_id: "ws-1",
    name: "n2",
    os: "linux",
    resolution: "1280x800x24",
  });
  assert.deepEqual(JSON.parse(String(seen[3].init.body)), { command: "echo hi", timeout: 12 });
  const form = seen[9].init.body as FormData;
  assert.equal(form.get("destPath"), "/opt/openmuse");
  assert.equal(form.get("desktopId"), "c1");
  assert.equal(form.get("workspaceId"), "ws-1");
  const failing = orgoDriver(config, async () => new Response("no", { status: 401 }));
  await assert.rejects(failing.find("x"), /Orgo returned 401/);
});
