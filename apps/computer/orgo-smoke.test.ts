import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { createApp } from "../server/src/app.ts";
import { computerIdentity } from "../server/src/computer.ts";
import { OrgoDesktopComputer, orgoDriver } from "../server/src/computer-orgo.ts";
import type { Config } from "../server/src/config.ts";
import { createStore } from "../server/src/db.ts";

// Explicit opt-in script against real Orgo: a unique deployment, and the one computer it
// creates is deleted afterwards. Run:
//   ORGO_API_KEY=... ORGO_WORKSPACE_ID=... pnpm test:computer:orgo
const apiKey = process.env.ORGO_API_KEY?.trim();
const workspace = process.env.ORGO_WORKSPACE_ID?.trim();
// Optional: keep each screenshot the agent would see, e.g. as proof of a run.
const shots = process.env.ORGO_SMOKE_SCREENSHOT_DIR?.trim();
test("real Orgo computer runs commands, opens GUI apps, acts, persists files and stops active work", {
  timeout: 900000,
  skip:
    !(apiKey && workspace) && "set ORGO_API_KEY and ORGO_WORKSPACE_ID to run the Orgo smoke test",
}, async () => {
  assert.equal(process.env.COMPUTER_PROVIDER, "orgo", "set COMPUTER_PROVIDER=orgo explicitly");
  const directory = await mkdtemp(join(tmpdir(), "openmuse-orgo-smoke-"));
  const db = await createStore();
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost/callback",
    allowedOrigins: [],
    computerEnabled: true,
    computerProvider: "orgo",
    orgoApiKey: apiKey,
    orgoWorkspaceId: workspace,
    orgoBaseUrl: process.env.ORGO_BASE_URL,
    computerDeploymentId: `smoke-${randomUUID()}`,
  };
  const server = await createApp(db, config);
  const owner = "local-user",
    labels = computerIdentity(config, owner).labels;
  const driver = orgoDriver(config);
  const name = `openmuse-${labels["dev.openmuse.deployment"]}-${labels["dev.openmuse.owner"]}`;
  const api = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${config.orgoBaseUrl ?? "https://www.orgo.ai/api"}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, ...init?.headers },
      signal: AbortSignal.timeout(180000),
    });
    assert.ok(response.ok, `${path}: HTTP ${response.status}`);
    return response;
  };
  const list = async () => {
    const body = (await (await api(`/workspaces/${workspace}`)).json()) as {
      desktops: { id: string; name: string }[];
    };
    return body.desktops
      .map(({ id, name }) => ({ id, name }))
      .sort((a, b) => a.id.localeCompare(b.id));
  };
  const beforeList = await list();
  console.log("workspace before (names/IDs only):", JSON.stringify(beforeList));
  assert.ok(!beforeList.some((item) => item.name === name));
  let createdId: string | undefined;
  try {
    const session = await server.auth.session();
    const headers = {
      Authorization: `Bearer ${session.token}`,
      "Content-Type": "application/json",
    };
    const call = async (path: string, body?: unknown) => {
      const response = await server.app.request(`/api/computer${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json();
      assert.ok(response.ok, `${path}: ${JSON.stringify(result)}`);
      return result;
    };
    const post = (path: string, body: unknown = {}) => call(path, body);
    let taken = 0;
    // A desktop action, then the JPEG screenshot it kept for the chat card.
    const act = async (action: Record<string, unknown>) => {
      const result = await post("/desktop/actions", action);
      assert.equal(result.receipt.status, "succeeded", JSON.stringify(result));
      assert.deepEqual([result.width, result.height], [1280, 800]);
      const response = await server.app.request("/api/computer/desktop/screenshot", { headers });
      assert.equal(response.headers.get("content-type"), "image/jpeg");
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
      assert.ok(bytes.length > 5000 && bytes.length < 1024 * 1024, String(bytes.length));
      if (shots) {
        await mkdir(shots, { recursive: true });
        await writeFile(
          join(shots, `${String(++taken).padStart(2, "0")}-${action.action}.jpg`),
          bytes,
        );
      }
      return bytes;
    };
    const pointer = async () =>
      (await post("/commands", { command: "DISPLAY=:99 xdotool getmouselocation" })).stdout;
    assert.equal((await call("")).status, "stopped");
    const started = await post("/start");
    assert.equal(started.status, "running");
    assert.equal(started.provider, "orgo");
    assert.equal(started.network, "enabled");
    const created = await driver.find(name);
    assert.equal(created?.status, "running");
    createdId = created?.id;
    assert.ok(createdId);
    const resize = (await (await api(`/computers/${createdId}/resize`)).json()) as {
      auto_stop_minutes: number;
    };
    assert.equal(resize.auto_stop_minutes, 15);
    console.log("auto_stop_minutes confirmed by authenticated GET: 15");
    const command = await post("/commands", {
      command:
        "pwd; python3 --version; git --version; printf 'persisted from bash\\n' > receipt.txt; echo oops >&2",
    });
    assert.equal(command.status, "succeeded", JSON.stringify(command));
    assert.match(command.stdout, /^\/workspace\nPython 3\./);
    assert.equal(command.stderr, "oops\n");
    await post("/files/mkdir", { path: "/workspace/notes" });
    await post("/files/write", {
      path: "/workspace/notes/hello.txt",
      text: "Hello from the API ✓",
    });
    assert.equal(
      (await post("/files/read", { path: "/workspace/notes/hello.txt" })).text,
      "Hello from the API ✓",
    );
    const missing = await post("/commands", { command: "pwd", cwd: "/workspace/missing" });
    assert.equal(missing.status, "failed");
    assert.equal(missing.exitCode, 126);
    const stdout = await post("/commands", { command: "python3 -c 'print(\"x\" * 300000)'" });
    assert.equal(stdout.status, "succeeded");
    assert.equal(stdout.truncated, true);
    assert.ok(Buffer.byteLength(stdout.stdout) <= 128 * 1024);
    await post("/commands", { command: "ln -s /etc /workspace/escape" });
    const escaped = await server.app.request("/api/computer/files/read", {
      method: "POST",
      headers,
      body: JSON.stringify({ path: "/workspace/escape/passwd" }),
    });
    assert.equal(escaped.status, 422);
    // A backgrounded GUI app must not hold the command open, and must keep running.
    const before = Date.now();
    const gui = await post("/commands", {
      command: "google-chrome --no-sandbox https://copilotkit.ai >/dev/null 2>&1 &",
    });
    assert.equal(gui.status, "succeeded", JSON.stringify(gui));
    assert.ok(Date.now() - before < 15000, "the GUI app held the command open");
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal((await post("/commands", { command: "pgrep -x chrome" })).status, "succeeded");
    // Input and screenshots on the freshly created computer.
    await act({ action: "screenshot" });
    await act({ action: "left_click", coordinate: [640, 400] });
    assert.match(await pointer(), /^x:640 y:400 /);
    await act({ action: "mouse_move", coordinate: [100, 120] });
    assert.match(await pointer(), /^x:100 y:120 /);
    // Typed input reaches a focused terminal window and runs there.
    await post("/commands", { command: "xfce4-terminal >/dev/null 2>&1 & sleep 3" });
    await act({ action: "type", text: "touch /workspace/typed" });
    await act({ action: "key", text: "Return" });
    await act({ action: "key", text: "ctrl+shift+q" });
    assert.equal(
      (await post("/commands", { command: "test -e /workspace/typed" })).status,
      "succeeded",
    );
    // Sideways scroll and a click at the pointer have no Orgo endpoint and run through xdotool.
    await act({ action: "scroll", coordinate: [640, 400], scroll_direction: "right" });
    await act({ action: "left_click" });
    // The same authenticated desktop route used by the app returns a local viewer.
    const view = await server.app.request("/api/computer/desktop", { headers });
    assert.equal(view.status, 200);
    const viewing = (await view.json()) as { url: string };
    assert.equal(new URL(viewing.url).pathname, "/computer-viewer");
    const fragment = new URLSearchParams(new URL(viewing.url).hash.slice(1));
    const socket = fragment.get("socket");
    assert.ok(socket);
    assert.ok(!viewing.url.includes(apiKey as string));
    // Verify actual VNC protocol bytes, not merely a successful HTTP upgrade.
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(socket);
      ws.binaryType = "arraybuffer";
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("VNC greeting timed out"));
      }, 15000);
      ws.addEventListener(
        "message",
        (event) => {
          clearTimeout(timeout);
          try {
            assert.match(Buffer.from(event.data as ArrayBuffer).toString(), /^RFB 003\./);
            resolve();
          } catch {
            reject(new Error("VNC greeting was not received"));
          } finally {
            ws.close();
          }
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error("VNC connection failed"));
        },
        { once: true },
      );
    });
    assert.equal((await server.app.request("/computer-viewer")).status, 200);
    assert.equal((await server.app.request("/computer-viewer/assets/core/rfb.js")).status, 200);
    console.log("authenticated desktop route, local viewer and real VNC protocol greeting passed");
    // Cancel a live command group, then verify its delayed side effect never ran.
    const desktop = new OrgoDesktopComputer(config, driver);
    const abort = new AbortController();
    const active = desktop.run(
      labels,
      "echo $$ > /workspace/cancel-pid; sleep 20; touch /workspace/cancel-survived",
      { timeoutMs: 30000, signal: abort.signal },
    );
    const deadline = Date.now() + 10000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      ready = (await driver.bash(createdId, "test -s /workspace/cancel-pid", 5)).exitCode === 0;
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(ready, "cancellation command did not start");
    abort.abort();
    assert.equal((await active).interrupted, true);
    const killed = await driver.bash(
      createdId,
      'p=$(cat /workspace/cancel-pid); ! kill -0 "$p" 2>/dev/null && test ! -e /workspace/cancel-survived',
      5,
    );
    assert.equal(killed.exitCode, 0);
    console.log("live cancellation killed the owned process group");
    // A runaway writer is bounded by the 30 second wrapper.
    const runaway = await post("/commands", { command: "yes" });
    assert.equal(runaway.truncated, true);
    const pdf = await PDFDocument.create();
    pdf.addPage();
    // Close to the 10 MB import limit: the request crosses the network in 8 MB parts.
    await pdf.attach(randomBytes(9.5 * 1024 * 1024), "noise.bin", {
      mimeType: "application/octet-stream",
    });
    const original = await server.files.import(owner, "smoke.pdf", await pdf.save(), "Smoke test");
    const importing = Date.now();
    await post("/files/import", { fileId: original.id, path: "/workspace/source.pdf" });
    console.log(`imported ${original.size ?? "?"} byte PDF in ${Date.now() - importing} ms`);
    await post("/commands", { command: "cp source.pdf output.pdf" });
    const exported = await post("/files/export", { path: "/workspace/output.pdf" });
    assert.deepEqual(
      await server.files.bytes(owner, exported.id),
      await server.files.bytes(owner, original.id),
    );
    // The inner 30 second timeout reports exit 124 and leaves the computer running.
    const slow = await post("/commands", { command: "sleep 40" });
    assert.equal(slow.status, "timed_out");
    assert.equal(slow.exitCode, 124);
    assert.equal((await call("")).status, "running");
    assert.equal((await post("/stop")).status, "stopped");
    assert.equal((await driver.find(name))?.status, "frozen");
    assert.equal((await post("/start")).status, "running");
    assert.equal(
      (await post("/files/read", { path: "/workspace/receipt.txt" })).text,
      "persisted from bash\n",
    );
    // Stop ends processes: the desktop is back, the old browser is not.
    assert.equal((await post("/commands", { command: "pgrep -x chrome" })).status, "failed");
    await act({ action: "screenshot" });
    // A stopped computer refuses desktop actions instead of resuming.
    await server.computer.stop(owner);
    assert.equal((await server.computer.snapshot(owner)).status, "stopped");
    const refused = await server.app.request("/api/computer/desktop/actions", {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "screenshot" }),
    });
    assert.equal(refused.status, 409);
    assert.ok(
      (await server.computer.snapshot(owner)).commands.some(
        (receipt) => receipt.id === command.id && receipt.status === "succeeded",
      ),
    );
  } finally {
    // Recover the unique newly created ID even if setup failed before Start returned.
    const current = await list();
    const candidates = current.filter(
      (item) => item.name === name && !beforeList.some((old) => old.id === item.id),
    );
    assert.ok(candidates.length <= 1, "ambiguous smoke cleanup; refusing deletion");
    const cleanupId = createdId ?? candidates[0]?.id;
    if (cleanupId) {
      assert.ok(!beforeList.some((item) => item.id === cleanupId));
      await api(`/computers/${cleanupId}`, { method: "DELETE" });
    }
    const afterList = await list();
    console.log("workspace after cleanup (names/IDs only):", JSON.stringify(afterList));
    if (shots) {
      await mkdir(shots, { recursive: true });
      await writeFile(join(shots, "workspace-before.json"), JSON.stringify(beforeList, null, 2));
      await writeFile(join(shots, "workspace-after.json"), JSON.stringify(afterList, null, 2));
    }
    assert.deepEqual(afterList, beforeList, "workspace list changed after smoke cleanup");
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
