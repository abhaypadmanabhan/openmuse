import type { ComputerSnapshot } from "../../../packages/domain/src/computer";

/** What the chat's desktop card shows for the newest use_desktop step. Only E2B Desktop
 * has a live stream (embedded on web, a link on native); Orgo has none yet, so it shows
 * the screenshot the step saved, and no Desktop tab or Open desktop link. Older cards
 * have no snapshot and go by the workspace's configured provider. */
export function desktopView(
  snapshot: ComputerSnapshot | undefined,
  os: string,
  provider?: ComputerSnapshot["provider"],
) {
  const live = (snapshot?.provider ?? provider) !== "orgo";
  if (!snapshot) return { show: "nothing", live } as const;
  if (snapshot.status !== "running") return { show: "offline", live } as const;
  return { show: live && os === "web" ? "stream" : "screenshot", live } as const;
}
