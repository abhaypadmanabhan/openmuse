import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ComputerState, computerOutput, type DockerResult } from "./computer.ts";
import type { DesktopComputer, DesktopStatus } from "./computer-backend.ts";
import {
  type DesktopAction,
  desktopInput,
  releaseModifiers,
  resolution,
} from "./computer-e2b-desktop.ts";
import type { Config } from "./config.ts";
import { AppError } from "./errors.ts";

const orgoBase = "https://www.orgo.ai/api";
const display = ":99"; // Orgo's boot screen
const controlMs = 10_000;
const createMs = 120_000;
// stop and start archive or restore the disk and run synchronously (about 40 seconds).
const lifecycleMs = 180_000;
const idleMinutes = 15; // Orgo suspends an idle computer itself; each operation counts as activity
// POST /files/upload accepts 10 MB per file; larger stdin goes up in parts.
const uploadPart = 8 * 1024 * 1024;
const inbox = "/tmp/openmuse-in";
const screenshotQuality = 80;
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

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
  /** The computer with this name in the configured workspace. Names are unique there. */
  find(name: string): Promise<OrgoInfo | undefined>;
  create(name: string): Promise<string>;
  /** Boot a stopped computer from its archived disk. */
  start(id: string): Promise<void>;
  /** Archive the disk and release the host: files stay, processes end. */
  stop(id: string): Promise<void>;
  autoStop(id: string, minutes: number): Promise<void>;
  viewer(id: string): Promise<string>;
  bash(
    id: string,
    command: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<OrgoBashResult>;
  upload(id: string, directory: string, filename: string, data: Uint8Array): Promise<void>;
  screenshot(id: string): Promise<Uint8Array>;
  input(id: string, action: OrgoInput, body: Record<string, unknown>): Promise<void>;
}

class OrgoError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// `fetcher` is the global fetch; tests pass a fake.
export function orgoDriver(config: Config, fetcher: typeof fetch = fetch): OrgoDriver {
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
  const ownership = (name: string) => join(config.dataDir, "orgo-computers", `${name}.json`);
  const refuse = () =>
    new AppError("Computer ownership does not match this deployment; refusing to attach", 409);
  return {
    async find(name) {
      const response = await request(`/workspaces/${encodeURIComponent(workspace())}`);
      const body = (await response.json()) as { desktops?: OrgoInfo[] };
      const matches = (body.desktops ?? []).filter(
        (item) => item.name === name && item.status !== "deleted",
      );
      if (!matches.length) return undefined;
      if (matches.length !== 1) throw refuse();
      let owned: { id: string };
      try {
        owned = JSON.parse(await readFile(ownership(name), "utf8")) as { id: string };
      } catch {
        throw refuse();
      }
      if (matches[0].id !== owned.id) throw refuse();
      const detail = await request(`/computers/${encodeURIComponent(owned.id)}`);
      const info = (await detail.json()) as OrgoInfo & {
        workspace_id?: string;
        project_id?: string;
        os?: string;
      };
      if (
        info.id !== owned.id ||
        info.name !== name ||
        (info.workspace_id ?? info.project_id) !== workspace() ||
        info.os !== "linux"
      )
        throw refuse();
      return { id: info.id, name: info.name, status: info.status };
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
      const { id } = (await response.json()) as { id: string };
      if (!id) throw new Error("Orgo create returned no computer ID");
      await mkdir(join(config.dataDir, "orgo-computers"), { recursive: true });
      await writeFile(ownership(name), JSON.stringify({ id }), { mode: 0o600 });
      return id;
    },
    async start(id) {
      await json(`/computers/${id}/start`, "POST", undefined, lifecycleMs);
    },
    async stop(id) {
      await json(`/computers/${id}/stop`, "POST", undefined, lifecycleMs);
    },
    async autoStop(id, minutes) {
      await json(`/computers/${id}/resize`, "PATCH", { auto_stop_minutes: minutes });
    },
    async viewer(id) {
      const response = await request(`/computers/${id}/vnc-password`);
      const { password } = (await response.json()) as { password: string };
      if (!password) throw new Error("Orgo returned no computer password");
      const origin = new URL(base).origin;
      const socket = new URL(`/desktops/${id}/ws/websockify`, origin);
      socket.protocol = socket.protocol === "https:" ? "wss:" : "ws:";
      socket.searchParams.set("token", password);
      const fragment = new URLSearchParams({ socket: socket.href, password });
      return `${config.publicUrl.replace(/\/$/, "")}/computer-viewer#${fragment}`;
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
  };
}

// Orgo's shell endpoint has no stdin and returns stdout and stderr as one string, so
// each call runs inside this wrapper: stdin comes from uploaded parts, and stderr
// follows a one-time marker line. `limit` bounds each stream like the Docker path does.
export function orgoCommand(
  command: string,
  token: string,
  inputId: string | undefined,
  limit: number,
  timeoutMs = 30_000,
) {
  const directory = `/tmp/${token}`;
  const launch = `import os,sys; os.setsid(); os.path.exists("${directory}/cancel") and sys.exit(130); os.execv("/usr/bin/timeout", ["timeout", "--signal=TERM", "--kill-after=2s", "${Math.ceil(timeoutMs / 1000)}s", "/bin/bash", "--noprofile", "--norc", "-c", sys.argv[1]])`;
  const feed = inputId ? `cat ${inbox}/${inputId}.* | ` : "";
  const script = [
    "exec 2>/dev/null",
    `d=${quote(directory)}; mkdir -p "$d" || exit 125`,
    'o="$d/out"; e="$d/err"',
    `trap 'rm -rf "$d"' EXIT`,
    '[ -e "$d/cancel" ] && exit 130',
    `${feed}python3 -c ${quote(launch)} "$1" >"$o" 2>"$e" ${inputId ? "" : "</dev/null"} &`,
    'p=$!; printf %s "$p" > "$d/pid"',
    '[ -e "$d/cancel" ] && kill -TERM -- -"$p" 2>/dev/null',
    'wait "$p"',
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
// The name selects candidates; the REST driver checks the persisted creation ID,
// workspace and Linux OS before any lifecycle, command, viewer or input operation.
export class OrgoDesktopComputer implements DesktopComputer {
  constructor(
    config: Config,
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
  async inspect(
    labels: Record<string, string>,
  ): Promise<(DesktopStatus & { id: string }) | undefined> {
    const info = await this.control(() => this.driver.find(this.name(labels)));
    if (!info) return undefined;
    if (info.name !== this.name(labels)) throw new AppError("Computer ownership mismatch", 409);
    if (info.status === "error")
      throw new AppError(
        "The Orgo computer is in an error state. Check it in the Orgo dashboard.",
        502,
      );
    if (!["running", "suspended", "frozen", "stopped"].includes(info.status))
      throw new AppError(
        "The Orgo computer is changing state or unavailable. Check its status before retrying.",
        409,
      );
    // frozen is Stop; stopped is a VM that went away. Suspended computers wake on
    // their next action, so they count as running.
    return {
      id: info.id,
      state: info.status === "frozen" || info.status === "stopped" ? "paused" : "running",
    };
  }
  async state(labels: Record<string, string>): Promise<ComputerState> {
    const info = await this.inspect(labels);
    return !info ? "missing" : info.state === "running" ? "running" : "stopped";
  }
  async start(labels: Record<string, string>) {
    const existing = await this.inspect(labels);
    let id = existing?.id;
    if (!id) id = await this.control(() => this.driver.create(this.name(labels)));
    else if (existing?.state !== "running")
      await this.control(() => this.driver.start(id as string));
    const target = id;
    await this.control(() => this.driver.autoStop(target, idleMinutes));
    const script = await loadFilesScript();
    await this.control(async () => {
      const prepared = await this.driver.bash(target, "mkdir -p /workspace /opt/openmuse", 30);
      if (prepared.exitCode !== 0)
        throw new AppError("Computer workspace could not be prepared", 503);
      await this.driver.upload(target, "/opt/openmuse", "files.py", Buffer.from(script));
    });
  }
  async stop(labels: Record<string, string>) {
    const info = await this.inspect(labels);
    if (info?.state === "running") await this.control(() => this.driver.stop(info.id));
  }
  private async running(labels: Record<string, string>, verified?: DesktopStatus) {
    const info =
      (verified as (DesktopStatus & { id: string }) | undefined) ?? (await this.inspect(labels));
    if (info?.state !== "running")
      throw new AppError("Start the computer before using its terminal or files", 409);
    return info.id;
  }
  async desktopUrl(labels: Record<string, string>): Promise<string> {
    const id = await this.running(labels);
    return this.control(() => this.driver.viewer(id));
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
        if (input.startsWith("xdotool ")) {
          const released = await this.driver.bash(id, `DISPLAY=${display} ${releaseModifiers}`, 30);
          if (released.exitCode !== 0) throw new Error("modifier release failed");
        }
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
      const command = desktopInput(action);
      const result = await this.driver.bash(id, `DISPLAY=${display} ${command}`, 30);
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
    let cancelling: Promise<void> | undefined;
    const abort = () => {
      result.interrupted = true;
      cancelling ??= this.driver
        .bash(
          id,
          `d=/tmp/${token}; mkdir -p "$d"; touch "$d/cancel"; if [ -s "$d/pid" ]; then p=$(cat "$d/pid"); kill -TERM -- -"$p" 2>/dev/null; sleep 2; kill -KILL -- -"$p" 2>/dev/null; fi; true`,
          10,
        )
        .then(
          () => {},
          () => {
            output.stderr(
              "Cancellation could not be confirmed; the guest timeout still bounds the command.",
            );
          },
        );
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (options.signal?.aborted) {
        abort();
        return finish();
      }
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
        orgoCommand(run, token, inputId, limit, options.timeoutMs),
        Math.ceil(options.timeoutMs / 1000) + 5,
      );
      const { stdout, stderr } = orgoSplit(shell.output, token);
      output.stdout(stdout);
      output.stderr(stderr);
      // Orgo reports -1 for a command killed by its timeout; the in-box wrapper normally
      // ends first with 124.
      if (shell.exitCode === -1) result.timedOut = true;
      else result.exitCode = shell.exitCode;
    } catch (error) {
      // A lost response leaves the outcome unknown. The independent guest timeout
      // remains active even if the HTTP request or cancellation call fails.
      result.interrupted = true;
      output.stderr(
        error instanceof OrgoError
          ? `The Orgo shell call failed with status ${error.status}; the outcome is unknown.`
          : "The Orgo shell call did not return; the outcome is unknown.",
      );
    } finally {
      options.signal?.removeEventListener("abort", abort);
      await cancelling;
    }
    return finish();
  }
}
