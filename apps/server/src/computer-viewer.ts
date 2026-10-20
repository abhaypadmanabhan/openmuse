import { readdir, readFile } from "node:fs/promises";
import { Hono } from "hono";
import { orgoSocketOrigin } from "./computer-orgo.ts";
import type { Config } from "./config.ts";

/** OpenMuse's own desktop viewer, for providers without a hosted page (Orgo). The page
 * (`pagePath`) is public and holds no secret. Its link carries a signed credential for
 * `viewerPath` in the fragment, which browsers never send to a server; on each connect the
 * page POSTs it to `viewerPath` for the socket and password. The app asks for a new link
 * every 2 minutes; it differs only in the fragment, so an open viewer takes it in place. */
export const viewerPath = "/api/computer/desktop/viewer";
const assetsPath = "/computer-viewer";
const pagePath = `${assetsPath}/desktop`;
const novncRoot = new URL("../", import.meta.resolve("@novnc/novnc"));

/** The viewer page link for a link `auth.sign` made for `viewerPath`: the same server,
 * with the signed query moved into the fragment. */
export function viewerLink(signed: string) {
  const server = signed.slice(0, signed.indexOf(viewerPath));
  return `${server}${pagePath}#${signed.slice(signed.indexOf("?") + 1)}`;
}

/** What the viewer does with each WebSocket close code Orgo documents. Every retry asks
 * for the password again, since Orgo can change it. 4008 waits for the viewer: an idle
 * tab that reconnected by itself would keep the computer busy for nobody. */
export const viewerCloses: Record<number, { retry: boolean; message: string }> = {
  1000: { retry: true, message: "The desktop connection ended." },
  1001: { retry: true, message: "Orgo restarted." },
  1006: { retry: true, message: "The desktop connection dropped." },
  4001: { retry: true, message: "Orgo refused the desktop password." },
  4003: { retry: true, message: "The computer is not running yet." },
  4004: { retry: false, message: "Orgo has no such computer. Start it again from OpenMuse." },
  4006: { retry: false, message: "The Orgo API key belongs to another workspace." },
  4008: { retry: false, message: "The desktop paused after 30 minutes without input." },
  4500: { retry: true, message: "Orgo could not reach the computer." },
  4502: { retry: true, message: "Orgo could not reach the computer." },
  4503: { retry: true, message: "Orgo could not reach the computer." },
};

/** Scripts only from this server, network only to it and Orgo's stream, and framing only
 * by the OpenMuse apps that may call the API. */
export function viewerPolicy(socketOrigin: string, frameOrigins: string[]) {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    `connect-src 'self' ${socketOrigin}`,
    `frame-ancestors 'self' ${frameOrigins.join(" ")}`.trim(),
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

export const viewerPage = () => `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<title>OpenMuse desktop</title><style>
html,body{height:100%;margin:0}body{background:#eef1f3;color:#172125;font:15px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
#screen,#screen>div{position:absolute;inset:0}#notice{position:absolute;left:12px;right:12px;top:12px;display:flex;gap:12px;align-items:center;justify-content:space-between;background:#fcfcfc;border-radius:14px;padding:12px 14px}
#notice[hidden]{display:none}button{font:inherit;border:1px solid #e9edef;border-radius:24px;padding:8px 14px;min-height:40px;background:#fcfcfc;color:inherit;cursor:pointer}
button:hover{background:#edf7fd}button:active{background:#dceefb}button:focus-visible{outline:2px solid #1473c8;outline-offset:2px}button[hidden]{display:none}
</style><div id="screen" aria-label="Computer desktop. You and your agent share it."></div>
<div id="notice" role="status"><span id="status">Connecting to the desktop…</span><button id="again" type="button" hidden>Reconnect</button></div>
<script type="module" src="viewer.js"></script></html>`;

async function novnc() {
  const { version } = JSON.parse(await readFile(new URL("package.json", novncRoot), "utf8")) as {
    version: string;
  };
  // Only noVNC's own module files are served, from a list made once; a request names
  // an entry in it, never a path on disk.
  const files = new Map<string, URL>();
  for (const directory of ["core", "vendor"])
    for (const entry of await readdir(new URL(directory, novncRoot), { recursive: true }))
      if (entry.endsWith(".js"))
        files.set(`${directory}/${entry}`, new URL(`${directory}/${entry}`, novncRoot));
  return { release: `novnc-${version}`, files };
}

/** The page's script. Exported for tests, which run it against stand-ins for the DOM. */
// Paths are relative to the page, so the viewer also works behind a path prefix.
export const viewerScript = (release: string) => `import RFB from "./${release}/core/rfb.js";
const screen = document.getElementById("screen"), notice = document.getElementById("notice");
const status = document.getElementById("status"), again = document.getElementById("again");
const closes = ${JSON.stringify(viewerCloses)};
// attempt numbers each connect; stop() bumps it, so a late answer for an older one is dropped.
let rfb, socket, pending, timer, deadline, attempts = 0, attempt = 0, expired = false;
let credential = location.hash.slice(1);
function say(text, button = false) {
  status.textContent = text;
  notice.hidden = !text;
  again.hidden = !button;
}
// Ends the current attempt and connection without reporting anything.
function stop() {
  attempt++;
  clearTimeout(timer);
  clearTimeout(deadline);
  pending?.abort();
  const old = rfb;
  pending = socket = rfb = undefined;
  old?.disconnect();
}
function retry(text) {
  if (attempts >= 6) return say(text + " Reconnect when the computer is ready.", true);
  say(text + " Reconnecting…");
  timer = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 15000));
}
function closed(code) {
  const close = closes[code];
  if (close?.retry) retry(close.message);
  else say(close?.message ?? "The desktop disconnected (code " + code + ").", true);
}
async function connect() {
  stop(); // one connection at a time
  expired = false;
  if (!credential) return say("Open the desktop from OpenMuse.");
  const mine = attempt;
  say("Connecting to the desktop…");
  const controller = (pending = new AbortController());
  let target;
  try {
    const response = await fetch("..${viewerPath}?" + credential, { method: "POST", cache: "no-store", signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (mine !== attempt) return;
    if (response.status === 401 || response.status === 403) {
      expired = true;
      return say("This desktop link has expired. Open the desktop again from OpenMuse.");
    }
    if (!response.ok) return retry(typeof body.error === "string" ? body.error : "The desktop could not be opened.");
    target = body;
  } catch {
    if (mine !== attempt) return;
    return retry("OpenMuse could not be reached.");
  }
  pending = undefined;
  // Our own socket, so the close code (which noVNC does not report) picks the next step.
  const ws = new WebSocket(target.socket + "?token=" + encodeURIComponent(target.password));
  ws.addEventListener("close", (event) => {
    if (socket !== ws) return;
    clearTimeout(deadline);
    socket = rfb = undefined; // noVNC has disconnected itself
    closed(event.code);
  });
  // Each connection draws into its own holder, so a closing one never covers the next.
  const holder = document.createElement("div");
  screen.replaceChildren(holder);
  const credentials = { password: target.password };
  const viewer = new RFB(holder, ws, { credentials, shared: true });
  socket = ws;
  rfb = viewer;
  // OpenMuse's surface colour around the scaled desktop, not noVNC's dark grey.
  Object.assign(viewer, { scaleViewport: true, resizeSession: false, focusOnClick: true, qualityLevel: 9, compressionLevel: 1, background: "#eef1f3" });
  viewer.addEventListener("credentialsrequired", () => viewer.sendCredentials(credentials));
  viewer.addEventListener("connect", () => {
    clearTimeout(deadline);
    attempts = 0;
    say("");
  });
  // noVNC can wait forever on a handshake that never finishes; this ends it and retries.
  deadline = setTimeout(() => {
    stop();
    retry("The desktop did not answer in time.");
  }, 25000);
}
again.addEventListener("click", () => {
  attempts = 0;
  connect();
});
// OpenMuse renews the credential by changing only the fragment; the next connect uses it.
// A viewer stopped by an expired credential connects again with the renewed one; a live or
// idle-paused viewer only keeps it.
window.addEventListener("hashchange", () => {
  credential = location.hash.slice(1);
  if (expired) {
    attempts = 0;
    connect();
  }
});
window.addEventListener("pagehide", stop);
// A page restored from the back-forward cache was stopped when it was hidden.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    attempts = 0;
    connect();
  }
});
connect();
`;

/** The viewer page, its script and noVNC's modules: public files with no credential in
 * them. The page is served only for Orgo, whose stream host its policy allows. */
export function viewerAssets(config: Config) {
  const app = new Hono();
  let assets: ReturnType<typeof novnc> | undefined;
  // Read on first use, so a broken install fails these requests, not the API's startup.
  const load = () => (assets ??= novnc());
  app.get(pagePath, (c) => {
    if (config.computerProvider !== "orgo") return c.notFound();
    c.header(
      "Content-Security-Policy",
      viewerPolicy(orgoSocketOrigin(config), [
        ...new Set([...config.allowedOrigins, new URL(config.publicUrl).origin]),
      ]),
    );
    return c.html(viewerPage());
  });
  app.get(`${assetsPath}/viewer.js`, async (c) => {
    c.header("Content-Type", "text/javascript; charset=utf-8");
    c.header("Cache-Control", "no-cache");
    return c.body(viewerScript((await load()).release));
  });
  app.get(`${assetsPath}/:release/*`, async (c) => {
    const { release, files } = await load();
    const base = `${assetsPath}/${release}`;
    const name = c.req.path.slice(base.length + 1);
    const file = c.req.path.startsWith(`${base}/`) ? files.get(name) : undefined;
    if (!file) return c.notFound();
    c.header("Content-Type", "text/javascript; charset=utf-8");
    // The release is in the path, so a cached copy never mixes noVNC versions.
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    return c.body(new Uint8Array(await readFile(file)));
  });
  return app;
}
