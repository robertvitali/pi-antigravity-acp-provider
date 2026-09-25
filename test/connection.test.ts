import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { AntigravityAcpConnection } from "../src/acp/connection.js";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));

describe("AntigravityAcpConnection", () => {
	it("disables native tools for new, loaded and resumed sessions", async () => {
		const connection = new AntigravityAcpConnection({ cwd: path.dirname(fakeAgent), command: process.execPath, args: [fakeAgent, "boundary-wire"] });
		try {
			await connection.initialize();
			await expect(connection.newSession(process.cwd())).resolves.toHaveProperty("sessionId");
			await expect(connection.loadSession("fake-session", process.cwd())).resolves.toHaveProperty("modes");
			await expect(connection.resumeSession("fake-session", process.cwd())).resolves.toHaveProperty("modes");
		} finally { await connection.close(); }
	});
	it("ignores known browser-launch stdout noise", async () => {
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent),
			command: process.execPath,
			args: [fakeAgent, "browser-noise"],
		});
		try {
			await expect(connection.initialize()).resolves.toMatchObject({
				agentInfo: { name: "fake-gemini" },
			});
			expect(connection.process.ignoredStdoutNoiseLines).toBe(1);
		} finally {
			await connection.close();
		}
	});

	it("rejects malformed output without an unhandled SDK receive rejection", async () => {
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent),
			command: process.execPath,
			args: [fakeAgent, "malformed-output"],
			initializeTimeoutMs: 5_000,
		});
		try {
			await expect(connection.initialize()).rejects.toThrow("malformed JSON");
		} finally {
			await connection.close();
		}
		expect(connection.process.alive).toBe(false);
	});

	it("rejects promptly and quietly when the agent exits before a request", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent),
			command: process.execPath,
			args: [fakeAgent, "exit-after-initialize"],
			operationTimeoutMs: 5_000,
		});
		try {
			await connection.initialize();
			await connection.process.exited;
			const started = Date.now();
			const error = await connection.newSession(process.cwd()).catch((cause: unknown) => cause);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).not.toContain("write after end");
			expect(Date.now() - started).toBeLessThan(500);
			expect(
				errorSpy.mock.calls.some((call) => String(call[0]).includes("ACP write error")),
			).toBe(false);
		} finally {
			errorSpy.mockRestore();
			await connection.close();
		}
	});

	it("reports a session timeout without leaking an unhandled rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => unhandled.push(error);
		process.on("unhandledRejection", onUnhandled);
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent),
			command: process.execPath,
			args: [fakeAgent, "session-timeout"],
			operationTimeoutMs: 25,
		});
		try {
			await connection.initialize();
			await expect(connection.newSession(process.cwd())).rejects.toThrow(
				"Antigravity ACP session/new timed out after 25ms",
			);
			await new Promise((resolve) => setTimeout(resolve, 25));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			await connection.close();
		}
	});

	it("includes safe structured details in ACP errors", async () => {
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent),
			command: process.execPath,
			args: [fakeAgent, "internal-error"],
		});
		try {
			await connection.initialize();
			const error = await connection.newSession(process.cwd()).catch((cause: unknown) => cause);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain(
				"Internal error: Permission denied: localharness_external",
			);
			expect((error as Error).message).toContain("api_key=<redacted>");
			expect((error as Error).message).not.toContain("AIza1234567890abcdefghijkl");
		} finally {
			await connection.close();
		}
	});

	it("uses the official SDK against a real child process", async () => {
		const updates: string[] = [];
		const connection = new AntigravityAcpConnection({
			cwd: path.dirname(fakeAgent),
			command: process.execPath,
			args: [fakeAgent],
			handlers: {
				onUpdate: (notification) => {
					updates.push(notification.update.sessionUpdate);
				},
			},
		});
		try {
			const initialize = await connection.initialize();
			expect(initialize.agentInfo?.name).toBe("fake-gemini");
			await connection.authenticate({ methodId: "api", _meta: { "api-key": "secret" } });
			const session = await connection.newSession(process.cwd());
			expect(session.models?.availableModels).toHaveLength(2);
			await connection.setModel(session.sessionId, "gemini-test");
			const response = await connection.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "hello" }],
			});
			expect(response.stopReason).toBe("end_turn");
			expect(updates).toEqual(["agent_thought_chunk", "agent_message_chunk"]);
		} finally {
			await connection.close();
		}
		expect(connection.process.alive).toBe(false);
	});
});
