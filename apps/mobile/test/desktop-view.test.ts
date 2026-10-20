import assert from "node:assert/strict";
import test from "node:test";
import type { ComputerSnapshot } from "../../../packages/domain/src/computer.ts";
import { desktopView } from "../src/desktop-view.ts";

const snapshot = (provider: ComputerSnapshot["provider"], status: ComputerSnapshot["status"]) =>
  ({ provider, status }) as ComputerSnapshot;

test("only E2B streams the desktop; Orgo shows the saved screenshot on every platform", () => {
  assert.deepEqual(desktopView(snapshot("e2b-desktop", "running"), "web"), {
    show: "stream",
    live: true,
  });
  assert.deepEqual(desktopView(snapshot("e2b-desktop", "running"), "ios"), {
    show: "screenshot",
    live: true,
  });
  for (const os of ["web", "ios", "android"])
    assert.deepEqual(desktopView(snapshot("orgo", "running"), os), {
      show: "screenshot",
      live: false,
    });
});

test("a stopped computer is offline, and a card without a snapshot keeps its Desktop tab link", () => {
  assert.equal(desktopView(snapshot("orgo", "stopped"), "web").show, "offline");
  assert.equal(desktopView(snapshot("e2b-desktop", "error"), "web").show, "offline");
  assert.deepEqual(desktopView(undefined, "web"), { show: "nothing", live: true });
});

test("older cards without a snapshot follow the workspace's provider", () => {
  assert.equal(desktopView(undefined, "web", "orgo").live, false);
  assert.equal(desktopView(undefined, "ios", "e2b-desktop").live, true);
  // A snapshot, when there is one, wins.
  assert.equal(desktopView(snapshot("e2b-desktop", "running"), "web", "orgo").live, true);
});
