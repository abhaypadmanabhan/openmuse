import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { DesktopComputer } from "../apps/server/src/computer-backend.ts";
import { viewerCloses, viewerScript } from "../apps/server/src/computer-viewer.ts";
import { createStore } from "../apps/server/src/db.ts";
import { config as base } from "./helpers/computer.ts";

const password = "vnc-secret-never-in-a-url";
const novnc = JSON.parse(
  await readFile(new URL("../node_modules/@novnc/novnc/package.json", import.meta.url), "utf8"),
) as { version: string };
const refuse = async (): Promise<never> => {
  throw new Error("not used by the viewer");
};
// The routes only need the viewer half of a desktop provider.
const desktop: DesktopComputer = {
  inspect: async () => ({ state: "running" }),
  state: async () => "running",
  start: refuse,
  stop: refuse,
  desktopUrl: async (_labels, _firstConnect, viewerLink) => (viewerLink as () => string)(),
  viewer: async () => ({ socket: "wss://staging.orgo.ai/desktops/c1/ws/websockify", password }),
  act: refuse,
  run: refuse,
};

async function server(provider: "orgo" | "e2b-desktop" = "orgo") {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-viewer-"));
  const db = await createStore();
  const created = await createApp(
    db,
    {
      ...base,
      dataDir,
      allowedOrigins: ["http://localhost:8081"],
      computerProvider: provider,
      orgoApiKey: "orgo-test-key-never-sent",
      orgoWorkspaceId: "ws-1",
      orgoBaseUrl: "https://staging.orgo.ai/api",
      e2bApiKey: "e2b-test-key-never-sent",
    },
    { desktop },
  );
  const { token } = await created.auth.session();
  return {
    ...created,
    headers: { Authorization: `Bearer ${token}` },
    close: async () => {
      await db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
const path = (url: string) => url.replace("http://localhost:8787", "");

test("the desktop link opens a public viewer page with its signed credential in the fragment", async () => {
  const s = await server();
  try {
    const { url } = (await (
      await s.app.request("/api/computer/desktop", { headers: s.headers })
    ).json()) as { url: string };
    // Browsers never send the fragment to a server, so the credential is in no request line.
    assert.match(
      url,
      /^http:\/\/localhost:8787\/computer-viewer\/desktop#owner=local-user&expires=\d+&signature=\w{64}$/,
    );
    assert.ok(!url.includes(password));
    const page = await s.app.request(path(url).split("#")[0]);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(!html.includes(password));
    assert.match(html, /<script type="module" src="viewer.js"><\/script>/);
    assert.equal(
      page.headers.get("Content-Security-Policy"),
      "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data: blob:; " +
        "connect-src 'self' wss://staging.orgo.ai; frame-ancestors 'self' http://localhost:8081 " +
        "http://localhost:8787; base-uri 'none'; form-action 'none'",
    );
    // The fragment's credential is the one the POST below accepts.
    const credential = url.split("#")[1];
    const answer = await s.app.request(`/api/computer/desktop/viewer?${credential}`, {
      method: "POST",
    });
    assert.equal(answer.status, 200);
  } finally {
    await s.close();
  }
});

test("only the signed credential gets the socket and password, and only for its own path", async () => {
  const s = await server();
  try {
    const signed = path(s.auth.sign("local-user", "/api/computer/desktop/viewer"));
    const answer = await s.app.request(signed, { method: "POST" });
    assert.equal(answer.status, 200);
    assert.deepEqual(await answer.json(), {
      socket: "wss://staging.orgo.ai/desktops/c1/ws/websockify",
      password,
    });
    assert.equal(answer.headers.get("Cache-Control"), "no-store");
    // No signature and no session.
    assert.equal(
      (await s.app.request("/api/computer/desktop/viewer", { method: "POST" })).status,
      401,
    );
    // A tampered signature, and a valid signature for another path.
    const tampered = signed.replace(
      /signature=(\w)/,
      (_, c) => `signature=${c === "a" ? "b" : "a"}`,
    );
    assert.equal((await s.app.request(tampered, { method: "POST" })).status, 403);
    const other = new URL(s.auth.sign("local-user", "/api/files/x/content"));
    assert.equal(
      (await s.app.request(`/api/computer/desktop/viewer${other.search}`, { method: "POST" }))
        .status,
      403,
    );
    // An expired credential.
    const expired = signed.replace(/expires=\d+/, "expires=1000");
    assert.equal((await s.app.request(expired, { method: "POST" })).status, 401);
  } finally {
    await s.close();
  }
});

test("E2B hosts its own viewer, so OpenMuse's viewer page is not served for it", async () => {
  const s = await server("e2b-desktop");
  try {
    assert.equal((await s.app.request("/computer-viewer/desktop")).status, 404);
  } finally {
    await s.close();
  }
});

test("the viewer script and noVNC's modules are public files, and nothing else is", async () => {
  const s = await server();
  try {
    const script = await s.app.request("/computer-viewer/viewer.js");
    assert.equal(script.status, 200);
    assert.equal(script.headers.get("Content-Type"), "text/javascript; charset=utf-8");
    const text = await script.text();
    assert.match(text, new RegExp(`^import RFB from "./novnc-${novnc.version}/core/rfb.js";`));
    const rfb = await s.app.request(`/computer-viewer/novnc-${novnc.version}/core/rfb.js`);
    assert.equal(rfb.status, 200);
    assert.equal(rfb.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
    assert.match(await rfb.text(), /export default class RFB/);
    assert.equal(
      (
        await s.app.request(
          `/computer-viewer/novnc-${novnc.version}/vendor/pako/lib/zlib/inflate.js`,
        )
      ).status,
      200,
    );
    for (const refused of [
      `/computer-viewer/novnc-${novnc.version}/package.json`,
      `/computer-viewer/novnc-${novnc.version}/docs/API.md`,
      `/computer-viewer/novnc-${novnc.version}/core/%2e%2e/package.json`,
      `/computer-viewer/novnc-${novnc.version}/core/..%2fpackage.json`,
      "/computer-viewer/novnc-0.0.1/core/rfb.js",
      "/computer-viewer/core/rfb.js",
    ])
      assert.equal((await s.app.request(refused)).status, 404, refused);
  } finally {
    await s.close();
  }
});

// The served script, run against stand-ins for the DOM, fetch, WebSocket and noVNC.
type Listener = (event: Record<string, unknown>) => void;
class Target {
  listeners = new Map<string, Listener[]>();
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: Record<string, unknown> = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}
class Element extends Target {
  textContent = "";
  hidden = false;
  children: Element[] = [];
  replaceChildren(...children: Element[]) {
    this.children = children;
  }
}
function viewer(t: TestContext, hash = "#owner=o&expires=9&signature=s") {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const elements = {
    screen: new Element(),
    notice: new Element(),
    status: new Element(),
    again: new Element(),
  };
  const sockets: (Target & { url: string; closed: boolean; close(): void })[] = [];
  const screens: (Target & { target: Element; disconnected: boolean; disconnect(): void })[] = [];
  const posts: {
    url: string;
    signal: AbortSignal;
    answer: (status: number, body: unknown, held?: boolean) => void;
  }[] = [];
  const window = new Target();
  const location = { hash };
  const fetch = (url: string, init: { signal: AbortSignal }) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      posts.push({
        url,
        signal: init.signal,
        // A held body is still being read when the answer arrives; aborting fails it.
        answer: (status, body, held = false) =>
          resolve({
            ok: status < 300,
            status,
            json: () =>
              held
                ? new Promise((_, fail) =>
                    init.signal.addEventListener("abort", () => fail(new Error("aborted"))),
                  )
                : Promise.resolve(body),
          }),
      });
    });
  class WebSocket extends Target {
    closed = false;
    constructor(readonly url: string) {
      super();
      sockets.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  class RFB extends Target {
    disconnected = false;
    constructor(readonly target: Element) {
      super();
      screens.push(this);
    }
    disconnect() {
      this.disconnected = true;
    }
    sendCredentials() {}
  }
  const document = {
    getElementById: (id: keyof typeof elements) => elements[id],
    createElement: () => new Element(),
  };
  const source = viewerScript("novnc-test").replace(/^import RFB from [^\n]+\n/, "");
  new Function("RFB", "document", "window", "location", "fetch", "WebSocket", source)(
    RFB,
    document,
    window,
    location,
    fetch,
    WebSocket,
  );
  const settle = () => new Promise((done) => setImmediate(done));
  const answer = async (
    status = 200,
    body: unknown = { socket: "wss://orgo.test/desktops/c1/ws/websockify", password: "p w" },
  ) => {
    posts.at(-1)?.answer(status, body);
    await settle();
  };
  return { ...elements, sockets, screens, posts, window, location, answer, settle };
}
const tick = async (t: TestContext, ms: number) => {
  t.mock.timers.tick(ms);
  await new Promise((done) => setImmediate(done));
};

test("the viewer connects with its fragment credential, and an idle close waits for Reconnect", async (t) => {
  const v = viewer(t);
  assert.equal(v.posts[0].url, "../api/computer/desktop/viewer?owner=o&expires=9&signature=s");
  await v.answer();
  assert.equal(v.sockets[0].url, "wss://orgo.test/desktops/c1/ws/websockify?token=p%20w");
  assert.deepEqual(v.screen.children, [v.screens[0].target]);
  v.screens[0].emit("connect");
  assert.equal(v.notice.hidden, true);
  v.sockets[0].emit("close", { code: 4008 });
  assert.match(v.status.textContent, /paused after 30 minutes/);
  assert.equal(v.again.hidden, false);
  // Nobody pressed Reconnect: nothing reconnects, however long the tab stays open, and the
  // app's renewed link is only kept.
  v.location.hash = "#renewed";
  v.window.emit("hashchange");
  await tick(t, 60 * 60_000);
  assert.equal(v.posts.length, 1);
  v.again.emit("click");
  assert.equal(v.posts.length, 2);
});

test("a transient close reconnects with a fresh password and the renewed credential", async (t) => {
  const v = viewer(t);
  await v.answer();
  v.screens[0].emit("connect");
  // OpenMuse renews the credential by changing only the fragment.
  v.location.hash = "#renewed";
  v.window.emit("hashchange");
  // A live viewer keeps its connection.
  assert.equal(v.posts.length, 1);
  v.sockets[0].emit("close", { code: 4500 });
  assert.match(v.status.textContent, /Reconnecting/);
  await tick(t, 1000);
  assert.equal(v.posts.length, 2);
  assert.equal(v.posts[1].url, "../api/computer/desktop/viewer?renewed");
  await v.answer(200, { socket: "wss://orgo.test/s", password: "second" });
  assert.equal(v.sockets[1].url, "wss://orgo.test/s?token=second");
  v.screens[1].emit("connect");
  // A computer that stays down is retried six times, then waits for Reconnect.
  for (let i = 0; i < 6; i++) {
    v.sockets.at(-1)?.emit("close", { code: 4003 });
    await tick(t, 15_000);
    await v.answer();
  }
  v.sockets.at(-1)?.emit("close", { code: 4003 });
  await tick(t, 60_000);
  assert.equal(v.posts.length, 8);
  assert.equal(v.again.hidden, false);
});

test("a stalled handshake is abandoned, and its late close never starts a second retry", async (t) => {
  const v = viewer(t);
  await v.answer();
  await tick(t, 25_000);
  // The stalled viewer is disconnected at once, not when its socket finally closes.
  assert.equal(v.screens[0].disconnected, true);
  await tick(t, 1000);
  assert.equal(v.posts.length, 2);
  await v.answer();
  assert.deepEqual(v.screen.children, [v.screens[1].target]);
  v.sockets[0].emit("close", { code: 1006 });
  await tick(t, 60_000);
  assert.equal(v.posts.length, 2);
});

test("an answer still being read when the page leaves starts nothing", async (t) => {
  const v = viewer(t);
  v.posts[0].answer(200, {}, true);
  await v.settle();
  v.window.emit("pagehide");
  await v.settle();
  assert.equal(v.sockets.length, 0);
  await tick(t, 60_000);
  assert.equal(v.posts.length, 1);
});

test("leaving the page cancels a pending connect, and a restored page reconnects", async (t) => {
  const v = viewer(t);
  v.window.emit("pagehide");
  assert.equal(v.posts[0].signal.aborted, true);
  await v.answer();
  assert.equal(v.sockets.length, 0);
  // Back-forward cache restores the stopped page.
  v.window.emit("pageshow", { persisted: true });
  assert.equal(v.posts.length, 2);
  await v.answer();
  v.screens[0].emit("connect");
  v.window.emit("pagehide");
  assert.equal(v.screens[0].disconnected, true);
  // The socket noVNC closes for pagehide reports nothing.
  v.sockets[0].emit("close", { code: 1000 });
  await tick(t, 60_000);
  assert.equal(v.posts.length, 2);
});

test("an expired credential stops with a message, and a renewed one reconnects", async (t) => {
  const v = viewer(t);
  await v.answer(401, { error: "Document link expired" });
  assert.match(v.status.textContent, /link has expired/);
  await tick(t, 60_000);
  assert.equal(v.posts.length, 1);
  // The app's next renewed link brings the stopped viewer back.
  v.location.hash = "#renewed";
  v.window.emit("hashchange");
  assert.equal(v.posts.length, 2);
  assert.equal(v.posts[1].url, "../api/computer/desktop/viewer?renewed");
});

test("a page opened without a credential asks to be opened from OpenMuse", (t) => {
  const missing = viewer(t, "");
  assert.equal(missing.posts.length, 0);
  assert.match(missing.status.textContent, /Open the desktop from OpenMuse/);
});

test("Orgo's documented transient closes are the ones retried", () => {
  const retried = Object.entries(viewerCloses)
    .filter(([, close]) => close.retry)
    .map(([code]) => Number(code));
  assert.deepEqual(retried, [1000, 1001, 1006, 4001, 4003, 4500, 4502, 4503]);
});
