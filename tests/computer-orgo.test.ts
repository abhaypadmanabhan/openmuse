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
  orgoSocketOrigin,
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
    /** Stop resolves only once this does, like a long Orgo archive. */
    stopGate?: Promise<void>;
    /** A suspended computer ignores the wake-up command. */
    staysSuspended?: boolean;
    pending?: () => boolean;
    /** What Orgo returns as the desktop password; null is a View only key's answer. */
    password?: string | null;
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
    passwords: [] as string[],
  };
  const add = (info: Partial<OrgoInfo>) => {
    const id = info.id ?? `cmp-${computers.size + 1}`;
    computers.set(id, { id, name: "", status: "running", ...info });
    return id;
  };
  const driver: OrgoDriver = {
    async list(name) {
      return [...computers.values()].filter((item) => item.name === name);
    },
    async create(name) {
      calls.create.push(name);
      return add({ name });
    },
    // Orgo's own rules (computers/start, computers/stop): anything else is a 409.
    async start(id) {
      calls.start.push(id);
      const info = computers.get(id) as OrgoInfo;
      if (!["frozen", "stopped", "running"].includes(info.status))
        throw new Error(`409 not_startable (status: ${info.status})`);
      info.status = "running";
    },
    async stop(id) {
      calls.stop.push(id);
      const info = computers.get(id) as OrgoInfo;
      if (info.status !== "running" && info.status !== "frozen")
        throw new Error(`409 not_stoppable (status: ${info.status})`);
      await options.stopGate;
      info.status = "frozen";
    },
    async pending() {
      return options.pending?.() ?? false;
    },
    async autoStop(id, minutes) {
      calls.autoStop.push({ id, minutes });
      if (options.autoStopFails) throw new Error("plan does not allow auto-stop");
    },
    async bash(id, command, timeout) {
      calls.bash.push({ command, timeout });
      // Any interaction resumes a suspended computer.
      const info = computers.get(id);
      if (info?.status === "suspended" && !options.staysSuspended) info.status = "running";
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
    async vncPassword(id) {
      calls.passwords.push(id);
      const password = options.password === undefined ? "vnc-pass-1" : options.password;
      if (!password) throw new Error("Orgo returned no desktop password");
      return password;
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

test("stop wakes a suspended computer first, since Orgo stops only a running one", async () => {
  const f = fake();
  const { computer, owner, desktop, labels: own } = service(f, { status: "suspended" });
  assert.equal(await desktop.state(own), "running");
  await computer.stop(owner);
  assert.deepEqual(
    f.calls.bash.map((call) => call.command),
    ["true"],
  );
  assert.deepEqual(f.calls.stop, ["pre"]);
  assert.equal(await desktop.state(own), "stopped");
  await computer.stop(owner);
  assert.equal(f.calls.stop.length, 1);
});

test("a suspended computer that does not wake is reported, not stopped blindly", async () => {
  const f = fake({ staysSuspended: true });
  const { computer, owner, desktop, labels: own } = service(f, { status: "suspended" });
  await assert.rejects(computer.stop(owner), { status: 503, message: /did not wake/ });
  assert.equal(f.calls.stop.length, 0);
  assert.equal(await desktop.state(own), "running");
});

test("creating, restarting and updating computers refuse work, Start and Stop", async () => {
  for (const status of ["creating", "restarting", "updating"]) {
    const f = fake();
    const { computer, owner, desktop, labels: own } = service(f, { status });
    const busy = { status: 409, message: new RegExp(`is ${status}`) };
    await assert.rejects(desktop.inspect(own), busy);
    await assert.rejects(computer.execute(owner, { command: "echo hi" }), busy);
    await assert.rejects(computer.desktopAction(owner, { action: "screenshot" }), busy);
    await assert.rejects(computer.start(owner), busy);
    await assert.rejects(computer.stop(owner), busy);
    assert.equal((await computer.snapshot(owner)).status, "error");
    assert.deepEqual([f.calls.bash, f.calls.start, f.calls.stop, f.calls.create], [[], [], [], []]);
    assert.equal(f.calls.screenshots, 0);
  }
  const unknown = service(fake(), { status: "hibernating" });
  await assert.rejects(unknown.desktop.inspect(unknown.labels), {
    status: 502,
    message: /unknown status/,
  });
});

test("Stop keeps the lease while Orgo is still stopping, so no command runs meanwhile", async (t) => {
  let release = () => {};
  const f = fake({ stopGate: new Promise<void>((done) => (release = done)) });
  const { computer, owner } = service(f, {});
  t.mock.timers.enable({ apis: ["Date", "setInterval"] });
  const stopping = computer.stop(owner);
  while (!f.calls.stop.length) await new Promise((done) => setImmediate(done));
  // Past one lease (180 s): the renewals keep it held.
  for (let minute = 0; minute < 4; minute++) {
    t.mock.timers.tick(60_000);
    for (let i = 0; i < 20; i++) await new Promise((done) => setImmediate(done));
  }
  await assert.rejects(computer.execute(owner, { command: "echo ran during stop" }), {
    status: 409,
  });
  await assert.rejects(computer.desktopAction(owner, { action: "screenshot" }), { status: 409 });
  assert.equal(f.calls.bash.length, 0);
  release();
  assert.equal((await stopping).status, "stopped");
  t.mock.timers.reset();
});

test("an operation Orgo has not settled keeps work away after the lease ends", async () => {
  let unsettled = true;
  const f = fake({ pending: () => unsettled });
  const { computer, owner } = service(f, {});
  await assert.rejects(computer.execute(owner, { command: "echo hi" }), {
    status: 409,
    message: /still starting or stopping/,
  });
  // The snapshot still shows what Orgo reports.
  assert.equal((await computer.snapshot(owner)).status, "running");
  assert.equal(f.calls.bash.length, 0);
  unsettled = false;
  assert.equal((await computer.execute(owner, { command: "echo hi" })).status, "succeeded");
  // A second Stop waits for Orgo too instead of stacking another operation.
  unsettled = true;
  await assert.rejects(computer.stop(owner), { status: 409, message: /still starting/ });
  assert.equal(f.calls.stop.length, 0);
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
    list: async () => {
      throw new Error("network down");
    },
  });
  await assert.rejects(broken.inspect(labels), (error: Error) => {
    assert.match(error.message, /ORGO_API_KEY/);
    assert.equal((error as { status?: number }).status, 503);
    return true;
  });
});

test("attaching fails closed on two computers with this owner's name", async () => {
  const f = fake();
  const { computer, owner, desktop, labels: own, name } = service(f, {});
  f.computers.set("twin", { id: "twin", name, status: "running" });
  await assert.rejects(desktop.inspect(own), { status: 409, message: /refusing to attach/ });
  await assert.rejects(computer.start(owner), { status: 409 });
  assert.equal(f.calls.create.length, 0);
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
  const options = { idempotencyKey: "key-once" };
  const action = { action: "key", text: "Return" };
  const uncertain = await a.computer.desktopAction(a.owner, action, options);
  assert.equal(uncertain.receipt.status, "interrupted");
  assert.match(uncertain.warning ?? "", /outcome is unknown/);
  // Never replayed: one dispatch, and the same operation ID sends nothing new.
  assert.equal(lost.calls.inputs.length, 1);
  const again = await a.computer.desktopAction(a.owner, action, options);
  assert.equal(again.receipt.id, uncertain.receipt.id);
  assert.match(again.warning ?? "", /no new desktop input was sent/);
  assert.equal(lost.calls.inputs.length, 1);
  const noShot = fake({ screenshotFails: true });
  const b = service(noShot, {});
  const delivered = await b.computer.desktopAction(b.owner, { action: "type", text: "x" });
  assert.equal(delivered.receipt.status, "succeeded");
  assert.match(delivered.warning ?? "", /screenshot could not be taken/);
  await assert.rejects(b.computer.desktopAction(b.owner, { action: "screenshot" }), {
    status: 503,
  });
});

test("the live view is a freshly signed viewer link, refused while stopped", async () => {
  const f = fake();
  const { computer, owner } = service(f, { status: "frozen" });
  let signed = 0;
  const link = () => `https://openmuse.test/viewer#n=${++signed}`;
  await assert.rejects(computer.desktopUrl(owner, link), { status: 409, message: /Start/ });
  (f.computers.get("pre") as OrgoInfo).status = "running";
  assert.deepEqual(await computer.desktopUrl(owner, link), {
    url: "https://openmuse.test/viewer#n=1",
  });
  // Every request signs anew, so a held link is as old as its fetch (Open desktop relies on it).
  assert.equal((await computer.desktopUrl(owner, link)).url, "https://openmuse.test/viewer#n=2");
  // Without a link to hand out there is nothing to open.
  await assert.rejects(computer.desktopUrl(owner), { status: 503 });
  // The client asks for the link every 2 minutes: that never wakes a suspended computer,
  // sends anything to it or fetches its password. Only a viewer's connect does.
  (f.computers.get("pre") as OrgoInfo).status = "suspended";
  assert.equal((await computer.desktopUrl(owner, link)).url, "https://openmuse.test/viewer#n=3");
  assert.deepEqual([f.calls.bash.length, f.calls.passwords.length], [0, 0]);
  assert.equal((f.computers.get("pre") as OrgoInfo).status, "suspended");
});

test("the viewer gets the Orgo stream and a fresh password, waking a suspended computer", async () => {
  const f = fake();
  const { computer, owner } = service(f, { status: "suspended" });
  assert.deepEqual(await computer.desktopViewer(owner), {
    socket: "wss://www.orgo.ai/desktops/pre/ws/websockify",
    password: "vnc-pass-1",
  });
  // Orgo's stream refuses a suspended computer (4003), so it is woken first.
  assert.deepEqual(
    f.calls.bash.map((call) => call.command),
    ["true"],
  );
  // Orgo can change the password: every connect asks again.
  await computer.desktopViewer(owner);
  assert.deepEqual(f.calls.passwords, ["pre", "pre"]);
  // The stream is on the API's host: staging streams from staging.
  assert.equal(
    orgoSocketOrigin({ orgoBaseUrl: "https://staging.orgo.ai/api" }),
    "wss://staging.orgo.ai",
  );
  assert.equal(orgoSocketOrigin({ orgoBaseUrl: "http://127.0.0.1:9/api" }), "ws://127.0.0.1:9");
  const stopped = fake();
  const off = service(stopped, { status: "frozen" });
  await assert.rejects(off.computer.desktopViewer(off.owner), { status: 409 });
  assert.equal(stopped.calls.passwords.length, 0);
  // A View only key gets no password from Orgo: refused as the app's 503, not an empty one.
  const viewOnly = service(fake({ password: null }), {});
  await assert.rejects(viewOnly.computer.desktopViewer(viewOnly.owner), { status: 503 });
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
  // The user watches and takes over the same desktop, as on E2B.
  assert.match(instructions, /watch and control the same desktop live from the app's Desktop tab/);
  assert.doesNotMatch(instructions, /Firefox|Xfce|Orgo|E2B|Docker/);
});

test("the REST driver sends the documented requests with the key as a bearer token", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const respond = (url: string): Response => {
    if (url.endsWith("/workspaces/ws-1"))
      return Response.json({ desktops: [{ id: "c1", name: "n1", status: "running" }] });
    if (url.endsWith("/computers")) return Response.json({ id: "c2" });
    if (url.includes("/screenshot")) return new Response(jpeg);
    if (url.endsWith("/bash")) return Response.json({ output: "hi\n", exit_code: 0 });
    if (url.endsWith("/vnc-password")) return Response.json({ password: "vnc-pass-2" });
    return Response.json({ success: true });
  };
  const driver = orgoDriver(
    { ...config, orgoBaseUrl: "https://orgo.test/api/" },
    async (url, init) => {
      seen.push({ url: String(url), init: init ?? {} });
      return respond(String(url));
    },
  );
  assert.deepEqual(await driver.list("n1"), [{ id: "c1", name: "n1", status: "running" }]);
  assert.deepEqual(await driver.list("other"), []);
  assert.equal(await driver.create("n2"), "c2");
  assert.deepEqual(await driver.bash("c1", "echo hi", 12), { output: "hi\n", exitCode: 0 });
  await driver.start("c1");
  await driver.stop("c1");
  await driver.autoStop("c1", 15);
  await driver.input("c1", "click", { x: 1, y: 2 });
  assert.deepEqual([...(await driver.screenshot("c1"))], [...jpeg]);
  await driver.upload("c1", "/opt/openmuse", "files.py", Buffer.from("x"));
  assert.equal(await driver.vncPassword("c1"), "vnc-pass-2");
  const calls = seen.map(
    (call) => `${call.init.method ?? "GET"} ${call.url.replace("https://orgo.test/api", "")}`,
  );
  assert.deepEqual(calls, [
    "GET /workspaces/ws-1",
    "GET /workspaces/ws-1",
    "POST /computers",
    "POST /computers/c1/bash",
    "POST /computers/c1/start?async=true",
    "POST /computers/c1/stop?async=true",
    "PATCH /computers/c1/resize",
    "POST /computers/c1/click",
    "GET /computers/c1/screenshot?response_format=binary&format=jpeg&quality=80",
    "POST /files/upload",
    "GET /computers/c1/vnc-password",
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
  await assert.rejects(failing.list("x"), /Orgo returned 401/);
  const viewOnly = orgoDriver(config, async () => Response.json({ password: null }));
  await assert.rejects(viewOnly.vncPassword("c1"), /no desktop password/);
});

test("start and stop wait for Orgo's operation instead of treating 202 as done", async () => {
  const seen: string[] = [];
  const polls: Record<string, string[]> = {
    "op-start": ["queued", "running", "succeeded"],
    "op-stop": ["running", "needs_review"],
  };
  const driver = orgoDriver(
    config,
    async (url, init) => {
      const path = String(url).replace("https://www.orgo.ai/api", "");
      seen.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/computers/c1/start?async=true")
        return Response.json({ operation_id: "op-start" }, { status: 202 });
      if (path === "/computers/c1/stop?async=true")
        return Response.json({ operation_id: "op-stop" }, { status: 202 });
      // Already in the requested state: Orgo answers 200 and starts no operation.
      if (path === "/computers/c2/start?async=true") return Response.json({ success: true });
      const op = path.match(/\/operations\/(op-[a-z]+)$/)?.[1];
      if (op) return Response.json({ status: polls[op].shift() });
      return new Response("unexpected", { status: 500 });
    },
    1,
  );
  await driver.start("c1");
  assert.deepEqual(seen.splice(0), [
    "POST /computers/c1/start?async=true",
    "GET /computers/c1/operations/op-start",
    "GET /computers/c1/operations/op-start",
    "GET /computers/c1/operations/op-start",
  ]);
  assert.equal(await driver.pending("c1"), false);
  await assert.rejects(driver.stop("c1"), /needs_review/);
  // needs_review stays pending until Orgo settles it.
  polls["op-stop"].push("needs_review", "succeeded");
  assert.equal(await driver.pending("c1"), true);
  assert.equal(await driver.pending("c1"), false);
  assert.equal(await driver.pending("c1"), false);
  assert.equal(seen.filter((call) => call.endsWith("/op-stop")).length, 4);
  await driver.start("c2");
  assert.deepEqual(seen.at(-1), "POST /computers/c2/start?async=true");
});

test("start and stop end at their deadline, and fail on failed or missing operations", async () => {
  let poll: (signal: AbortSignal) => Promise<Response> = async () =>
    Response.json({ status: "running" });
  const driver = orgoDriver(
    config,
    async (url, init) => {
      const path = String(url).replace("https://www.orgo.ai/api", "");
      if (path === "/computers/c1/stop?async=true")
        return Response.json({ operation_id: "op-1" }, { status: 202 });
      if (path === "/computers/c2/stop?async=true") return new Response("{}", { status: 202 });
      return poll(init?.signal as AbortSignal);
    },
    5,
    200,
  );
  const timed = async (work: Promise<unknown>, pattern: RegExp) => {
    const begun = Date.now();
    await assert.rejects(work, pattern);
    return Date.now() - begun;
  };
  // Running forever: the wait ends at the budget, and the operation stays pending.
  assert.ok((await timed(driver.stop("c1"), /still running/)) < 1000);
  assert.equal(await driver.pending("c1"), true);
  // A poll that answers only after the deadline is cut off, not accepted late.
  poll = (signal) =>
    new Promise((_, fail) => signal.addEventListener("abort", () => fail(signal.reason)));
  // AbortSignal.timeout does not hold the event loop open; a server would.
  const awake = setInterval(() => {}, 20);
  const late = await timed(driver.stop("c1"), /timeout|abort/i).finally(() => clearInterval(awake));
  assert.ok(late >= 150 && late < 1000, String(late));
  // A success decoded after the deadline is not accepted late either.
  poll = async () => {
    await new Promise((done) => setTimeout(done, 250));
    return Response.json({ status: "succeeded" });
  };
  await assert.rejects(driver.stop("c1"), /still running/);
  poll = async () => Response.json({ status: "failed" });
  await assert.rejects(driver.stop("c1"), /ended as failed/);
  assert.equal(await driver.pending("c1"), false);
  await assert.rejects(driver.stop("c2"), /no stop operation/);
});
