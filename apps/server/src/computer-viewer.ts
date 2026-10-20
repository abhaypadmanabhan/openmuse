import { readFile } from "node:fs/promises";
import { Hono } from "hono";

// Public static viewer; the authenticated /api/computer/desktop route supplies the
// computer credential in the fragment, which is never sent to this HTTP server.
export function computerViewer() {
  const app = new Hono();
  app.get("/", (c) =>
    c.html(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<title>Computer desktop</title>
<style>html,body,#screen{height:100%;margin:0;background:#f2f1ef;color:#292e33}#status{position:absolute;top:12px;left:12px;font:18px system-ui}</style>
<div id="screen"></div><div id="status" role="status">Connecting to desktop…</div>
<script type="module">
import RFB from '/computer-viewer/assets/core/rfb.js';
const params = new URLSearchParams(location.hash.slice(1));
const status = document.getElementById('status');
try {
  const socket = params.get('socket');
  if (!socket || !['wss:', 'ws:'].includes(new URL(socket).protocol)) throw Error();
  const password = params.get('password');
  const rfb = new RFB(document.getElementById('screen'), socket, { credentials: { password } });
  rfb.scaleViewport = true;
  rfb.addEventListener('credentialsrequired', () => rfb.sendCredentials({ password }));
  rfb.addEventListener('connect', () => { status.textContent = ''; });
  rfb.addEventListener('disconnect', () => { status.textContent = 'Desktop disconnected. Reopen the desktop to reconnect.'; });
  rfb.addEventListener('securityfailure', () => { status.textContent = 'Desktop access expired. Reopen the desktop to reconnect.'; });
} catch { status.textContent = 'Desktop could not connect. Reopen it from Computer.'; }
</script></html>`),
  );
  const root = new URL("../", import.meta.resolve("@novnc/novnc"));
  app.get("/assets/*", async (c) => {
    const path = c.req.path.split("/assets/")[1] ?? "";
    if (!/^(core|vendor)\/[a-zA-Z0-9_./-]+\.js$/.test(path) || path.split("/").includes(".."))
      return c.notFound();
    try {
      const bytes = await readFile(new URL(path, root));
      c.header("Content-Type", "text/javascript; charset=utf-8");
      return c.body(new Uint8Array(bytes));
    } catch {
      return c.notFound();
    }
  });
  return app;
}
