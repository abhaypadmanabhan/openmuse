import type { ComputerSnapshot } from "../../../packages/domain/src/computer";

/** Whether the computer has a live desktop and a Desktop tab: E2B hosts its viewer page,
 * and the OpenMuse server serves one for Orgo. Docker has no desktop. */
export const hasDesktop = (provider: ComputerSnapshot["provider"]) => provider !== "docker";

/** The desktop link Open desktop may reuse. Orgo's viewer links last 15 minutes, so one
 * fetched within the last 10 is opened straight from the press (a browser may block a tab
 * opened after waiting on the network); an older one is fetched again. */
export const reusableLink = (url: string, fetchedAt: number, now = Date.now()) =>
  url && now - fetchedAt < 10 * 60_000 ? url : undefined;
