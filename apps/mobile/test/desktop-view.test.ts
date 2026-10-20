import assert from "node:assert/strict";
import test from "node:test";
import { hasDesktop, reusableLink } from "../src/desktop-view.ts";

test("E2B and Orgo computers have a live desktop and a Desktop tab; Docker has neither", () => {
  assert.equal(hasDesktop("e2b-desktop"), true);
  assert.equal(hasDesktop("orgo"), true);
  assert.equal(hasDesktop("docker"), false);
});

test("Open desktop reuses a link fetched in the last 10 minutes and fetches an older one again", () => {
  const at = 1_000_000;
  assert.equal(reusableLink("https://x/viewer", at, at + 9 * 60_000), "https://x/viewer");
  // After the client stops refreshing (an hour) the held link may have expired.
  assert.equal(reusableLink("https://x/viewer", at, at + 10 * 60_000), undefined);
  assert.equal(reusableLink("", at, at), undefined);
});
