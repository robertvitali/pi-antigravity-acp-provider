import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { accessSync, constants } from "node:fs";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { resolveAntigravityAcpLaunch } from "./antigravity.js";
import { redact } from "./errors.js";
const STDERR_LIMIT = 16 * 1024;
// Longer than supervisor.mjs's 750 ms agent-tree escalation window.
const KILL_GRACE_MS = 1_500;
let nextGeneration = 1;

export interface AntigravityProcessOptions {
	cwd: string;
	entryPath?: string;
	command?: string;
	args?: string[];
	env?: NodeJS.ProcessEnv;
	shutdownGraceMs?: number;
}

export interface ProcessExit {
	code: number | null;
	signal: NodeJS.Signals | null;
	stderrTail: string;
}

export function resolveSupervisorEntry(): string {
	return fileURLToPath(new URL("./supervisor.mjs", import.meta.url));
}

export function resolveAntigravityAcpEntry(): string {
	// Kept as a compatibility export for diagnostics; the provider now targets
	// Google Antigravity's ACP server rather than the retired Gemini CLI client.
	return resolveAntigravityAcpLaunch().command;
}

export class AntigravityProcess {
	readonly generation = nextGeneration++;
	readonly child: ChildProcessWithoutNullStreams;
	readonly input: ReadableStream<Uint8Array>;
	readonly output: WritableStream<Uint8Array>;
	readonly exited: Promise<ProcessExit>;
	private stderr = "";
	private ignoredStdoutNoise = 0;
	private settled = false;
	private closing?: Promise<void>;
	private readonly shutdownGraceMs: number;
	private readonly hardKillWaitMs: number;

	constructor(options: AntigravityProcessOptions) {
		this.shutdownGraceMs = options.shutdownGraceMs ?? KILL_GRACE_MS;
		this.hardKillWaitMs = options.shutdownGraceMs === undefined ? KILL_GRACE_MS : 1_000;
		let command: string;
		let args: string[];
		if (options.command) {
			command = options.command;
			args = options.args ?? [];
		} else {
			const launch = options.entryPath
				? { command: process.execPath, args: [options.entryPath, ...(options.args ?? [])] }
				: resolveAntigravityAcpLaunch();
			command = process.execPath;
			args = [resolveSupervisorEntry(), "--command", launch.command, ...launch.args];
		}
		let resolveExit!: (exit: ProcessExit) => void;
		this.exited = new Promise((resolve) => {
			resolveExit = resolve;
		});

		const child = spawn(command, args, {
			cwd: path.resolve(options.cwd),
			env: subscriptionEnvironment(options.env ?? process.env),
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
			windowsHide: true,
			detached: process.platform !== "win32",
		});
		this.child = child;
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.stderr = redact((this.stderr + chunk).slice(-STDERR_LIMIT));
		});
		child.once("error", (cause) => {
			this.finish(resolveExit, null, null, `spawn failed: ${cause.message}`);
		});
		child.once("exit", (code, signal) => {
			this.finish(resolveExit, code, signal, this.stderr);
		});

		this.input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
		this.output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
	}

	get pid(): number | undefined {
		return this.child.pid;
	}

	get stderrTail(): string {
		return this.stderr;
	}

	get ignoredStdoutNoiseLines(): number {
		return this.ignoredStdoutNoise;
	}

	recordCompatibilityNoise(): void {
		this.ignoredStdoutNoise += 1;
	}

	get alive(): boolean {
		// child.killed only records that kill() was called; it does not mean the
		// process has exited. Keep it alive until exit/error settles.
		return !this.settled && this.child.exitCode === null;
	}

	async close(): Promise<void> {
		this.closing ??= this.closeOnce();
		return this.closing;
	}

	private async closeOnce(): Promise<void> {
		if (!this.alive) return;
		// Do not end stdin independently of the Web WritableStream adapter. An
		// in-flight SDK write may otherwise reach Node after stdin.end() and raise
		// ERR_STREAM_WRITE_AFTER_END as an uncaught stream error. Terminating the
		// owned process tree closes all three stdio streams together.
		this.signal("SIGTERM");
		const exited = await Promise.race([
			this.exited.then(() => true),
			delay(this.shutdownGraceMs).then(() => false),
		]);
		if (!exited && this.alive) {
			this.signal("SIGKILL");
			await Promise.race([this.exited, delay(this.hardKillWaitMs)]);
		}
	}

	private signal(signal: NodeJS.Signals): void {
		try {
			if (process.platform === "win32" && this.child.pid) {
				const args = ["/PID", String(this.child.pid), "/T"];
				if (signal === "SIGKILL") args.push("/F");
				spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
				return;
			}
			if (this.child.pid) process.kill(-this.child.pid, signal);
			else this.child.kill(signal);
		} catch {
			// ESRCH means the process tree is already gone.
		}
	}

	private finish(
		resolve: (exit: ProcessExit) => void,
		code: number | null,
		signal: NodeJS.Signals | null,
		stderrTail: string,
	): void {
		if (this.settled) return;
		this.settled = true;
		resolve({ code, signal, stderrTail: redact(stderrTail) });
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}


/** Keep saved personal OAuth as the only billing route. */
function subscriptionEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
 const env = { ...input };
 for (const key of Object.keys(env)) {
  if (/^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_.*|GCLOUD_.*|CLOUDSDK_.*|AGY_ACP_CCPA_.*|AGY_ACP_ENABLE_OAUTH|GOOGLE_GENAI_USE_VERTEXAI|ANTIGRAVITY_HARNESS_PATH|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|LD_PRELOAD|DYLD_.*)$/.test(key)) delete env[key];
 }
 return env;
}

/** Explicit opt-in for the Pi-owned ACP profile; does not change default launches. */
export function resolveHistorySupervisorLaunch(): { command: string; args: string[]; shutdownGraceMs: number } {
 if (process.platform !== "darwin") throw new Error("ACP history cleanup requires macOS /usr/bin/python3");
 const command = "/usr/bin/python3";
 accessSync(command, constants.X_OK);
 return { command, args: ["-I", "-B", fileURLToPath(new URL("./history-supervisor.py", import.meta.url))], shutdownGraceMs: 10_000 };
}
