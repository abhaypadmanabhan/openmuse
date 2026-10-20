import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type ComputerState, computerOutput, type DockerResult } from "./computer.ts";
import type { DesktopComputer, DesktopStatus } from "./computer-backend.ts";
import { type DesktopAction, desktopInput, resolution } from "./computer-e2b-desktop.ts";
import type { Config } from "./config.ts";
import { AppError } from "./errors.ts";

const orgoBase = "https://www.orgo.ai/api";
const display = ":99"; // Orgo's boot screen
const controlMs = 10_000;
const createMs = 120_000;
// stop and start archive or restore the disk as Orgo operations (often about 40 seconds,
// sometimes minutes); this bounds the whole wait for one, like Orgo's own synchronous limit.
const lifecycleMs = 300_000;
const idleMinutes = 15; // Orgo suspends an idle computer itself; each operation counts as activity
// POST /files/upload accepts 10 MB per file; larger stdin goes up in parts.
const uploadPart = 8 * 1024 * 1024;
const inbox = "/tmp/openmuse-in";
const screenshotQuality = 80;
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
// Every status GET /computers/{id} documents. Suspended computers wake on their next
// action; frozen is Stop and stopped is a VM that went away, both started again by Start.
// error and anything undocumented are refused.
const statuses = new Map<string, "running" | "suspended" | "paused" | "busy">([
  ["running", "running"],
  ["suspended", "suspended"],
  ["frozen", "paused"],
  ["stopped", "paused"],
  ["creating", "busy"],
  ["restarting", "busy"],
  ["updating", "busy"],
]);

export interface OrgoInfo {
  id: string;
  name: string;
  status: string;
}
export interface OrgoBashResult {
  output: string;
  exitCode: number;
}
export type OrgoInput = "click" | "type" | "key" | "scroll" | "mouse-move";
/** The slice of the Orgo REST API this provider uses; tests replace it with a fake. */
export interface OrgoDriver {
  /** Every computer with this name in the configured workspace. */
  list(name: string): Promise<OrgoInfo[]>;
  create(name: string): Promise<string>;
  /** Boot a stopped computer from its archived disk. */
  start(id: string): Promise<void>;
  /** Archive the disk and release the host: files stay, processes end. */
  stop(id: string): Promise<void>;
  /** Whether a start or stop this driver began for the computer has not settled yet. */
  pending(id: string): Promise<boolean>;
  autoStop(id: string, minutes: number): Promise<void>;
  bash(
    id: string,
    command: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<OrgoBashResult>;
  upload(id: string, directory: string, filename: string, data: Uint8Array): Promise<void>;
  screenshot(id: string): Promise<Uint8Array>;
  input(id: string, action: OrgoInput, body: Record<string, unknown>): Promise<void>;
  /** The desktop's VNC password. It can change, so it is fetched for each viewer session. */
  vncPassword(id: string): Promise<string>;
}

class OrgoError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// `fetcher` is the global fetch, `pollMs` the operation poll interval and `budgetMs` the
// bound on one start or stop; tests pass fakes.
export function orgoDriver(
  config: Config,
  fetcher: typeof fetch = fetch,
  pollMs = 2000,
  budgetMs = lifecycleMs,
): OrgoDriver {
  const base = (config.orgoBaseUrl ?? orgoBase).replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${config.orgoApiKey}` };
  const request = async (path: string, init: RequestInit = {}, timeoutMs = controlMs) => {
    const signals = [AbortSignal.timeout(timeoutMs), ...(init.signal ? [init.signal] : [])];
    const response = await fetcher(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...init.headers },
      signal: AbortSignal.any(signals),
    });
    if (!response.ok) throw new OrgoError(response.status, `Orgo returned ${response.status}`);
    return response;
  };
  const json = (
    path: string,
    method: string,
    body?: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ) =>
    request(
      path,
      {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      },
      timeoutMs,
    );
  const workspace = () => {
    if (!config.orgoWorkspaceId) throw new OrgoError(0, "ORGO_WORKSPACE_ID is not set");
    return config.orgoWorkspaceId;
  };
  // A synchronous start or stop answers 202 once Orgo's own wait runs out, so both run
  // as operations and are polled until they settle. 200 means it was already done.
  // An operation still running at the deadline, or in needs_review, stays recorded so
  // `pending` keeps new work away until Orgo settles it.
  const unsettled = new Map<string, string>();
  const operation = async (id: string, operationId: string, timeoutMs = controlMs) => {
    const poll = await request(
      `/computers/${id}/operations/${encodeURIComponent(operationId)}`,
      {},
      timeoutMs,
    );
    const { status } = (await poll.json()) as { status?: string };
    if (status === "succeeded" || status === "failed") unsettled.delete(id);
    return { status, code: poll.status };
  };
  const lifecycle = async (id: string, action: "start" | "stop") => {
    const deadline = Date.now() + budgetMs;
    const left = () => deadline - Date.now();
    // Each request and sleep fits in what is left, so a late answer cannot overrun it.
    const bound = () => Math.max(1, Math.min(controlMs, left()));
    // An answer that arrives after the deadline is not accepted either: the caller has
    // stopped waiting, and a retry finds the computer's settled state.
    const inTime = () => {
      if (left() < 0) throw new OrgoError(0, `Orgo ${action} is still running`);
    };
    const response = await json(
      `/computers/${id}/${action}?async=true`,
      "POST",
      undefined,
      bound(),
    );
    if (response.status !== 202) return inTime();
    const { operation_id } = (await response.json()) as { operation_id?: string };
    if (!operation_id) throw new OrgoError(202, `Orgo returned no ${action} operation`);
    unsettled.set(id, operation_id);
    for (;;) {
      if (left() <= 0) throw new OrgoError(0, `Orgo ${action} is still running`);
      const { status, code } = await operation(id, operation_id, bound());
      if (status === "succeeded") return inTime();
      if (status !== "queued" && status !== "running")
        throw new OrgoError(code, `Orgo ${action} ended as ${status}`);
      await new Promise((done) => setTimeout(done, Math.min(pollMs, Math.max(0, left()))));
    }
  };
  return {
    async list(name) {
      const response = await request(`/workspaces/${encodeURIComponent(workspace())}`);
      const body = (await response.json()) as { desktops?: OrgoInfo[] };
      return (body.desktops ?? []).filter(
        (item) => item.name === name && item.status !== "deleted",
      );
    },
    async create(name) {
      const response = await json(
        "/computers",
        "POST",
        {
          workspace_id: workspace(),
          name,
          os: "linux",
          resolution: `${resolution.join("x")}x24`,
        },
        createMs,
      );
      return ((await response.json()) as { id: string }).id;
    },
    start: (id) => lifecycle(id, "start"),
    stop: (id) => lifecycle(id, "stop"),
    async pending(id) {
      const operationId = unsettled.get(id);
      if (!operationId) return false;
      try {
        const { status } = await operation(id, operationId);
        return status !== "succeeded" && status !== "failed";
      } catch (error) {
        // Orgo forgets an operation once it is settled and gone.
        if (error instanceof OrgoError && error.status === 404) {
          unsettled.delete(id);
          return false;
        }
        throw error;
      }
    },
    async autoStop(id, minutes) {
      await json(`/computers/${id}/resize`, "PATCH", { auto_stop_minutes: minutes });
    },
    async bash(id, command, timeoutSeconds, signal) {
      const response = await json(
        `/computers/${id}/bash`,
        "POST",
        { command, timeout: timeoutSeconds },
        (timeoutSeconds + 35) * 1000,
        signal,
      );
      const body = (await response.json()) as { output?: string; exit_code?: number };
      return { output: body.output ?? "", exitCode: body.exit_code ?? -1 };
    },
    async upload(id, directory, filename, data) {
      const form = new FormData();
      form.append("file", new Blob([data as BlobPart]), filename);
      form.append("workspaceId", workspace());
      form.append("desktopId", id);
      form.append("destPath", directory);
      await request("/files/upload", { method: "POST", body: form }, 60_000);
    },
    async screenshot(id) {
      const response = await request(
        `/computers/${id}/screenshot?response_format=binary&format=jpeg&quality=${screenshotQuality}`,
        {},
        30_000,
      );
      return new Uint8Array(await response.arrayBuffer());
    },
    async input(id, action, body) {
      await json(`/computers/${id}/${action}`, "POST", body, 35_000);
    },
    async vncPassword(id) {
      const response = await request(`/computers/${id}/vnc-password`);
      // A key with View only access to the workspace gets no password.
      const { password } = (await response.json()) as { password?: string | null };
      if (!password) throw new OrgoError(response.status, "Orgo returned no desktop password");
      return password;
    },
  };
}

/** Where Orgo streams every computer's desktop: the API host, over WebSocket. */
export function orgoSocketOrigin(config: Pick<Config, "orgoBaseUrl">) {
  const api = new URL(config.orgoBaseUrl ?? orgoBase);
  return `${api.protocol === "http:" ? "ws:" : "wss:"}//${api.host}`;
}

// Orgo's shell endpoint has no stdin and returns stdout and stderr as one string, so
// each call runs inside this wrapper: stdin comes from uploaded parts, and stderr
// follows a one-time marker line. `limit` bounds each stream like the Docker path does.
export function orgoCommand(
  command: string,
  token: string,
  inputId: string | undefined,
  limit: number,
) {
  const script = [
    "exec 2>/dev/null",
    "o=$(mktemp) e=$(mktemp) || exit 125",
    inputId
      ? `cat ${inbox}/${inputId}.* | /bin/bash --noprofile --norc -c "$1" >"$o" 2>"$e"`
      : `/bin/bash --noprofile --norc -c "$1" >"$o" 2>"$e" </dev/null`,
    "s=$?",
    inputId ? `rm -f ${inbox}/${inputId}.*` : ":",
    `head -c ${limit + 1} "$o"`,
    `printf '\\n%s\\n' ${token}`,
    `head -c ${limit + 1} "$e"`,
    'rm -f "$o" "$e"',
    "exit $s",
  ].join("\n");
  return `/bin/bash --noprofile --norc -c ${quote(script)} openmuse ${quote(command)}`;
}

/** Splits wrapper output at the marker line into stdout and stderr. */
export function orgoSplit(output: string, token: string) {
  const marker = `\n${token}\n`;
  const at = output.lastIndexOf(marker);
  return at < 0
    ? { stdout: output, stderr: "" }
    : { stdout: output.slice(0, at), stderr: output.slice(at + marker.length) };
}

let filesScript: Promise<string> | undefined;
// Source runs from apps/server/src; the built server runs from the repository root.
const loadFilesScript = () =>
  (filesScript ??= readFile(new URL("../../computer/files.py", import.meta.url), "utf8").catch(() =>
    readFile(resolve("apps/computer/files.py"), "utf8"),
  ));

// Runs each owner's computer as one Orgo Linux computer, found by name in one workspace.
// Stopped means frozen: /workspace lives on the archived disk and processes end.
// Orgo has no labels, so the name carries the deployment and owner hashes; refusing a
// computer whose name differs is the whole ownership check.
export class OrgoDesktopComputer implements DesktopComputer {
  constructor(
    private readonly config: Config,
    private readonly driver: OrgoDriver = orgoDriver(config),
  ) {}
  private name(labels: Record<string, string>) {
    return `openmuse-${labels["dev.openmuse.deployment"]}-${labels["dev.openmuse.owner"]}`;
  }
  private async control<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "Orgo computer operation failed. Check ORGO_API_KEY and ORGO_WORKSPACE_ID.",
        503,
      );
    }
  }
  // The workspace record, refused unless it is unambiguously ours and in a known state.
  private async find(labels: Record<string, string>) {
    const found = await this.control(() => this.driver.list(this.name(labels)));
    if (!found.length) return undefined;
    // Fail closed like E2B: two computers with one owner's name are not ours to pick from.
    if (found.length > 1)
      throw new AppError(
        "Computer ownership or isolation does not match this deployment; refusing to attach",
        409,
      );
    const info = found[0];
    const kind = statuses.get(info.status);
    if (kind === "busy")
      throw new AppError(`The Orgo computer is ${info.status}. Try again in a minute.`, 409);
    if (!kind)
      throw new AppError(
        info.status === "error"
          ? "The Orgo computer is in an error state. Check it in the Orgo dashboard."
          : "The Orgo computer reports an unknown status. Check it in the Orgo dashboard.",
        502,
      );
    return { ...info, kind };
  }
  /** The computer, if work may be sent to it now. */
  async inspect(
    labels: Record<string, string>,
  ): Promise<(DesktopStatus & { id: string; suspended: boolean }) | undefined> {
    const info = await this.find(labels);
    if (!info) return undefined;
    // A start or stop Orgo has not settled yet: its outcome is unknown, so nothing runs.
    if (await this.control(() => this.driver.pending(info.id)))
      throw new AppError(
        "Orgo is still starting or stopping this computer. Try again in a minute.",
        409,
      );
    return {
      id: info.id,
      state: info.kind === "paused" ? "paused" : "running",
      suspended: info.kind === "suspended",
    };
  }
  async state(labels: Record<string, string>): Promise<ComputerState> {
    const info = await this.find(labels);
    return !info ? "missing" : info.kind === "paused" ? "stopped" : "running";
  }
  async start(labels: Record<string, string>) {
    const existing = await this.inspect(labels);
    const id = existing?.id ?? (await this.control(() => this.driver.create(this.name(labels))));
    if (existing && existing.state !== "running") await this.control(() => this.driver.start(id));
    // Best effort: auto-stop is not offered on every Orgo plan. Without it the
    // computer keeps running until Stop.
    await this.driver.autoStop(id, idleMinutes).catch(() => {});
    const script = await loadFilesScript();
    await this.control(async () => {
      const prepared = await this.driver.bash(id, "mkdir -p /workspace /opt/openmuse", 30);
      if (prepared.exitCode !== 0)
        throw new AppError("Computer workspace could not be prepared", 503);
      await this.driver.upload(id, "/opt/openmuse", "files.py", Buffer.from(script));
    });
  }
  // A suspended computer resumes on interaction, not through start: wake it with a
  // no-op command and check. `step` names what needs it awake.
  private async wake(labels: Record<string, string>, id: string, step: string) {
    await this.control(() => this.driver.bash(id, "true", 30)).catch(() => undefined);
    if ((await this.find(labels))?.kind !== "running")
      throw new AppError(
        `The Orgo computer is suspended and did not wake ${step}. Try again in a minute.`,
        503,
      );
  }
  async stop(labels: Record<string, string>) {
    const info = await this.inspect(labels);
    if (info?.state !== "running") return;
    // Orgo stops only a running computer.
    if (info.suspended) await this.wake(labels, info.id, "to stop");
    await this.control(() => this.driver.stop(info.id));
  }
  private async running(labels: Record<string, string>, verified?: DesktopStatus) {
    const info =
      (verified as (DesktopStatus & { id: string }) | undefined) ?? (await this.inspect(labels));
    if (info?.state !== "running")
      throw new AppError("Start the computer before using its terminal or files", 409);
    return info.id;
  }
  /** Orgo hosts no viewer page, so the link is OpenMuse's own viewer (`viewerLink`). The
   * client asks again every 2 minutes, so this never wakes a suspended computer: only a
   * viewer's connect does (`viewer`), and after Orgo's idle close that waits for input. */
  async desktopUrl(
    labels: Record<string, string>,
    _firstConnect?: unknown,
    viewerLink?: () => string,
  ): Promise<string> {
    if (!viewerLink) throw new AppError("The desktop viewer is not available", 503);
    if ((await this.inspect(labels))?.state !== "running")
      throw new AppError("Start the computer before opening its desktop", 409);
    return viewerLink();
  }
  /** What OpenMuse's viewer page connects to. The password controls the whole computer
   * (desktop, terminal and shell), so only the signed-in owner's viewer receives it. */
  async viewer(labels: Record<string, string>) {
    const info = await this.inspect(labels);
    if (info?.state !== "running")
      throw new AppError("Start the computer before opening its desktop", 409);
    // Orgo's stream refuses a suspended computer (4003), so a connect wakes it.
    if (info.suspended) await this.wake(labels, info.id, "for the desktop");
    const password = await this.control(() => this.driver.vncPassword(info.id));
    return {
      socket: `${orgoSocketOrigin(this.config)}/desktops/${encodeURIComponent(info.id)}/ws/websockify`,
      password,
    };
  }
  /** Perform one GUI action and return the screenshot taken after it. */
  async act(
    labels: Record<string, string>,
    action: DesktopAction,
    beforeInput?: () => Promise<void>,
  ) {
    const id = await this.running(labels);
    let uncertain = false;
    const input = desktopInput(action);
    if (input) {
      await beforeInput?.();
      try {
        await this.perform(id, action);
      } catch {
        // A lost response cannot tell us whether the input was delivered, and the
        // wrapper never replays it.
        uncertain = true;
      }
    }
    const warning = uncertain
      ? "The desktop input outcome is unknown: it may already have been performed. Inspect a fresh screenshot before repeating the action; do not automatically retry it."
      : undefined;
    const screen = { mimeType: "image/jpeg" as const, width: resolution[0], height: resolution[1] };
    try {
      if (input) await new Promise((done) => setTimeout(done, 500));
      const image = await this.control(() => this.driver.screenshot(id));
      return { ...screen, image, uncertain, warning };
    } catch (error) {
      if (!input) throw error;
      return {
        ...screen,
        image: new Uint8Array(),
        uncertain,
        warning:
          warning ??
          "Action performed; the screenshot could not be taken. Take a screenshot before retrying the action.",
      };
    }
  }
  // Native Orgo endpoints where they exist. Sideways scroll and a click or scroll at
  // the current pointer have no endpoint, so those run xdotool on the boot screen.
  private async perform(id: string, action: DesktopAction) {
    const [x, y] = action.coordinate ?? [];
    const at = action.coordinate ? { x, y } : undefined;
    const fallback = async () => {
      const result = await this.driver.bash(id, `DISPLAY=${display} ${desktopInput(action)}`, 30);
      if (result.exitCode !== 0) throw new Error("desktop input failed");
    };
    switch (action.action) {
      case "screenshot":
        return;
      case "left_click":
        return at ? this.driver.input(id, "click", at) : fallback();
      case "right_click":
        return at ? this.driver.input(id, "click", { ...at, button: "right" }) : fallback();
      case "double_click":
        return at ? this.driver.input(id, "click", { ...at, double: true }) : fallback();
      case "mouse_move":
        return this.driver.input(id, "mouse-move", { x, y });
      case "type":
        return this.driver.input(id, "type", { text: action.text });
      case "key":
        for (const key of (action.text ?? "").trim().split(/\s+/))
          await this.driver.input(id, "key", { key });
        return;
      case "scroll": {
        const direction = action.scroll_direction;
        if (!at || (direction !== "up" && direction !== "down")) return fallback();
        return this.driver.input(id, "scroll", {
          ...at,
          direction,
          amount: action.scroll_amount ?? 3,
        });
      }
      case "wait":
        return new Promise((done) => setTimeout(done, (action.duration ?? 1) * 1000));
    }
  }

  /** Same contract as DockerRunner: command outcomes are results, never exceptions. */
  async run(
    labels: Record<string, string>,
    command: string,
    options: {
      cwd?: string;
      input?: string;
      timeoutMs: number;
      signal?: AbortSignal;
      maxOutputBytes?: number;
      propagateAttachError?: boolean;
      verified?: DesktopStatus;
    },
  ): Promise<DockerResult> {
    const output = computerOutput(options.maxOutputBytes);
    const { result, limit, finish } = output;
    let id: string;
    try {
      id = await this.running(labels, options.verified);
    } catch (error) {
      if (options.propagateAttachError) throw error;
      result.stderr =
        error instanceof AppError ? error.message : "The computer could not be reached.";
      return result;
    }
    if (options.signal?.aborted) {
      result.interrupted = true;
      return finish();
    }
    const token = `openmuse-${randomBytes(12).toString("hex")}`;
    const inputId = options.input === undefined ? undefined : randomUUID();
    const run = `cd ${quote(options.cwd ?? "/workspace")} 2>/dev/null || { echo "The working directory does not exist." >&2; exit 126; }; ${command}`;
    try {
      if (inputId) {
        // The shell endpoint has no stdin and a 128 KB argument limit, so the
        // request is uploaded as files and piped in.
        const data = Buffer.from(options.input ?? "", "utf8");
        for (let part = 0, at = 0; at < Math.max(data.length, 1); part++, at += uploadPart)
          await this.driver.upload(
            id,
            inbox,
            `${inputId}.${String(part).padStart(4, "0")}`,
            data.subarray(at, at + uploadPart),
          );
      }
      const shell = await this.driver.bash(
        id,
        orgoCommand(run, token, inputId, limit),
        Math.ceil(options.timeoutMs / 1000),
        options.signal,
      );
      const { stdout, stderr } = orgoSplit(shell.output, token);
      output.stdout(stdout);
      output.stderr(stderr);
      // Orgo reports -1 for a command killed by its timeout; the in-box wrapper normally
      // ends first with 124.
      if (shell.exitCode === -1) result.timedOut = true;
      else result.exitCode = shell.exitCode;
    } catch (error) {
      // A lost response leaves the outcome unknown, and an Orgo shell call cannot be
      // cancelled: the in-box timeout is the only bound. The service stops the box.
      result.interrupted = true;
      output.stderr(
        error instanceof OrgoError
          ? `The Orgo shell call failed with status ${error.status}; the outcome is unknown.`
          : "The Orgo shell call did not return; the outcome is unknown.",
      );
    }
    return finish();
  }
}
