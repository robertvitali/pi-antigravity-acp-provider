import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AntigravityAcpError } from "./errors.js";

export interface AntigravityLaunch {
	command: string;
	args: string[];
	source: "env" | "user-bin" | "managed" | "path";
}

export function resolveAntigravityAcpLaunch(): AntigravityLaunch {
	const env = process.env.AGY_ACP_BIN?.trim();
	if (env) {
		const command = expandHome(env);
		if (executable(command)) return directOrWrapper(command, "env");
	}

	// Prefer the provider's verified active release over ambient executables.
	// AGY_ACP_BIN remains the explicit opt-out for user-managed installations.
	const managedRoot = path.join(os.homedir(), ".local", "opt", "agy-acp", "current");
	for (const name of ["agy_acp_server.par", "agy_acp_server.exe"]) {
		const managed = path.join(managedRoot, name);
		if (executable(managed)) return directOrWrapper(managed, "managed");
	}

	const userBin = path.join(os.homedir(), ".local", "bin", "agy_acp_server.par");
	if (executable(userBin)) return { command: userBin, args: [], source: "user-bin" };

	for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!directory) continue;
		const candidate = path.join(directory, "agy_acp_server.par");
		if (executable(candidate)) return directOrWrapper(candidate, "path");
	}

	throw new AntigravityAcpError(
		"spawn",
		"Google Antigravity ACP server is not installed. Install/enable agy ACP or set AGY_ACP_BIN.",
	);
}

export type AntigravityAuthStatus =
	| "api-key-env"
	| "oauth-refreshable"
	| "configured-not-authenticated"
	| "corrupt"
	| "missing";

export interface AntigravityAuthHealth {
	status: AntigravityAuthStatus;
	authType?: string;
	tokenFile: boolean;
	settingsFile: boolean;
}

/** Structural local health only. A network probe is required to call an OAuth
 * token valid; secret values are never returned or logged. */
export function inspectAntigravityAuth(
	directory = path.join(expandHome(process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini")), "antigravity-acp"),
): AntigravityAuthHealth {
	const tokenPath = path.join(directory, "acp_token.json");
	const settingsPath = path.join(directory, "settings.json");
	const tokenFile = regularFile(tokenPath);
	const settingsFile = regularFile(settingsPath);
	let authType: string | undefined;
	if (settingsFile) {
		try {
			const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
				auth?: { type?: unknown };
			};
			if (typeof settings.auth?.type === "string") authType = settings.auth.type;
		} catch {
			return { status: "corrupt", tokenFile, settingsFile };
		}
	}
	if (authType && authType !== "oauth-personal") return { status: "configured-not-authenticated", authType, tokenFile, settingsFile };
	if (tokenFile) {
		try {
			const token = JSON.parse(fs.readFileSync(tokenPath, "utf8")) as { refresh_token?: unknown };
			if (typeof token.refresh_token === "string" && token.refresh_token.length > 0) {
				return { status: authType === "oauth-personal" ? "oauth-refreshable" : "configured-not-authenticated", ...(authType ? { authType } : {}), tokenFile, settingsFile };
			}
			return { status: "corrupt", ...(authType ? { authType } : {}), tokenFile, settingsFile };
		} catch {
			return { status: "corrupt", ...(authType ? { authType } : {}), tokenFile, settingsFile };
		}
	}
	if (authType) return { status: "configured-not-authenticated", authType, tokenFile, settingsFile };
	return { status: "missing", tokenFile, settingsFile };
}

export function hasAntigravityAuth(): boolean {
	const status = inspectAntigravityAuth().status;
	return status === "oauth-refreshable";
}

/** Local logout. Google currently advertises logout as an agent command rather
 * than an ACP SDK RPC, so this removes the local refresh token and auth choice. */
export function clearAntigravityCredentials(
	directory = path.join(expandHome(process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini")), "antigravity-acp"),
): void {
	fs.rmSync(path.join(directory, "acp_token.json"), { force: true });
	const settingsPath = path.join(directory, "settings.json");
	try {
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
		delete settings.auth;
		const temporary = `${settingsPath}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(temporary, settingsPath);
	} catch {
		fs.rmSync(settingsPath, { force: true });
	}
}

function directOrWrapper(command: string, source: AntigravityLaunch["source"]): AntigravityLaunch {
	try {
		const fd = fs.openSync(command, "r");
		const bytes = Buffer.alloc(64);
		const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
		fs.closeSync(fd);
		if (bytes.subarray(0, count).toString("utf8").startsWith("#!")) {
			return { command, args: [], source };
		}
	} catch {
		// Native executable; use the server's required empty uid argument.
	}
	return { command, args: process.platform === "linux" ? ["--uid="] : [], source };
}

function executable(file: string): boolean {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

function regularFile(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

function expandHome(file: string): string {
	return file === "~" || file.startsWith("~/") ? path.join(os.homedir(), file.slice(1)) : file;
}
