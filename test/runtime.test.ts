import type { Context, Model } from "@earendil-works/pi-ai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { AcpSessionStore } from "../src/acp/session-store.js";
import {
	AntigravityRuntime,
	MANAGED_AUTH_MARKER,
} from "../src/runtime.js";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const model: Model<"antigravity-acp"> = {
	id: "gemini-test",
	name: "Gemini Test",
	api: "antigravity-acp",
	provider: "antigravity-acp",
	baseUrl: "",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 8_192,
};

describe("AntigravityRuntime", () => {
	it("selects personal OAuth by exact ID when business login is advertised first", async () => {
		const runtime = new AntigravityRuntime((options) => new AntigravityAcpConnection({
			...options, command: process.execPath, args: [fakeAgent, "business-first"],
		}));
		try { await expect(runtime.loginGoogle()).resolves.toBeUndefined(); }
		finally { await runtime.close(); }
	});
	it("does not prompt when closed during session creation", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let ready!: () => void;
		const created = new Promise<void>((resolve) => { ready = resolve; });
		let connection!: AntigravityAcpConnection;
		let bridgeUrl: string | undefined;
		const runtime = new AntigravityRuntime((options) => {
			connection = new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] });
			const newSession = connection.newSession.bind(connection);
			vi.spyOn(connection, "newSession").mockImplementation(async (...args) => {
				const session = await newSession(...args);
				const server = args[2]?.[0];
				if (server && "url" in server) bridgeUrl = server.url;
				ready();
				await gate;
				return session;
			});
			vi.spyOn(connection, "prompt");
			return connection;
		});
		const writer = runtime.stream(model, {
			tools: [{ name: "echo", description: "Echo", parameters: Type.Object({ text: Type.String() }) }],
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		}, { sessionId: "closing" });
		await created;
		const closing = runtime.close();
		release();
		await closing;
		for await (const event of writer.stream) { void event; }
		expect(connection.prompt).not.toHaveBeenCalled();
		expect(connection.process.alive).toBe(false);
		expect((await runtime.snapshot()).bindings).toBe(0);
		expect(bridgeUrl).toBeDefined();
		await expect(fetch(bridgeUrl!)).rejects.toThrow();
	});
	it.each(["orphan-tool"])("clears orphaned timers on process exit: %s", async (scenario) => {
		const timers: ReturnType<typeof setTimeout>[] = [];
		const originalSetTimeout = globalThis.setTimeout;
		const setTimer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
			const timer = originalSetTimeout(...args);
			if (args[1] === 120_000) timers.push(timer);
			return timer;
		}) as typeof setTimeout);
		const clearTimer = vi.spyOn(globalThis, "clearTimeout");
		let connection!: AntigravityAcpConnection;
		const runtime = new AntigravityRuntime((options) => (connection = new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent, scenario] })));
		try {
			const writer = runtime.stream(model, {
				tools: [{ name: "echo", description: "Echo", parameters: Type.Object({ text: Type.String() }) }],
				messages: [{ role: "user", content: scenario === "orphan-tool" ? "use bridge" : "permission", timestamp: 1 }],
			}, { sessionId: "orphan" });
			for await (const event of writer.stream) { void event; }
			await new Promise((resolve) => originalSetTimeout(resolve, 50));
			expect(timers.some((timer) => !clearTimer.mock.calls.some(([cleared]) => cleared === timer))).toBe(true);
			await connection.close();
			await new Promise((resolve) => originalSetTimeout(resolve, 10));
			expect(timers.every((timer) => clearTimer.mock.calls.some(([cleared]) => cleared === timer))).toBe(true);
		} finally { await runtime.close(); setTimer.mockRestore(); clearTimer.mockRestore(); }
	});
	it("rejects API keys even when reusing an existing session", async () => {
		const runtime = new AntigravityRuntime((options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }));
		try {
			const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
			const first = runtime.stream(model, context, { sessionId: "auth-reuse" });
			for await (const event of first.stream) { void event; }
			const next = runtime.stream(model, context, { sessionId: "auth-reuse", apiKey: "paid-key" });
			for await (const event of next.stream) { void event; }
			expect(next.message.errorMessage).toContain("subscription OAuth");
		} finally { await runtime.close(); }
	});
	it("requires the personal OAuth method without initiating login", async () => {
		const runtime = new AntigravityRuntime((options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent, "no-personal-oauth"] }));
		try { await expect(runtime.discoverModels(MANAGED_AUTH_MARKER)).rejects.toThrow("personal OAuth"); }
		finally { await runtime.close(); }
	});
	it("rejects API-key verification before starting a process", async () => {
		let spawned = false;
		const runtime = new AntigravityRuntime(() => { spawned = true; throw new Error("must not spawn"); });
		await expect(runtime.verifyApiKey("paid-key")).rejects.toThrow("subscription OAuth");
		expect(spawned).toBe(false);
	});
	it("rejects API-key streaming and discovery", async () => {
		const runtime = new AntigravityRuntime((options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }));
		try {
			await expect(runtime.discoverModels("paid-key")).rejects.toThrow("subscription OAuth");
			const writer = runtime.stream(model, { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, { apiKey: "paid-key" });
			for await (const event of writer.stream) { void event; }
			expect(writer.message.errorMessage).toContain("subscription OAuth");
		} finally { await runtime.close(); }
	});
	it("rejects mode changes that an active session did not advertise", async () => {
		const runtime = new AntigravityRuntime((options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent, "default-mode-only"] }));
		try {
			const writer = runtime.stream(model, { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, { sessionId: "mode-test" });
			for await (const event of writer.stream) { void event; }
			await expect(runtime.setPermissionMode("yolo")).rejects.toThrow("mode yolo");
			expect((await runtime.snapshot()).permissionMode).toBe("default");
		} finally { await runtime.close(); }
	});
	it("rejects native permissions without offering a Pi approval", async () => {
		const runtime = new AntigravityRuntime((options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }));
		try {
			const writer = runtime.stream(model, { messages: [{ role: "user", content: "permission", timestamp: 1 }] });
			const events = [];
			for await (const event of writer.stream) events.push(event);
			expect(events.some((event) => event.type === "toolcall_start")).toBe(false);
			expect(writer.message.content).toEqual([{ type: "text", text: "Decision: cancelled" }]);
		} finally { await runtime.close(); }
	});
	it("fails closed and cleans up when the requested mode is unavailable", async () => {
		let connection: AntigravityAcpConnection | undefined;
		const runtime = new AntigravityRuntime((options) => (connection = new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent, "missing-mode"] })));
		try {
			const writer = runtime.stream(model, { messages: [{ role: "user", content: "hello", timestamp: 1 }] });
			const events = [];
			for await (const event of writer.stream) events.push(event);
			expect(events.at(-1)?.type).toBe("error");
			expect(writer.message.errorMessage).toContain("mode default");
			expect(connection?.process.alive).toBe(false);
		} finally { await runtime.close(); }
	});
	it("recognizes Gemini CLI's advertised Google login method", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			await expect(runtime.loginGoogle()).resolves.toBeUndefined();
		} finally {
			await runtime.close();
		}
	});

	it("relays Google login through Pi on a headless host", async () => {
		const previousMode = process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE;
		process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE = "manual";
		const runtime = new AntigravityRuntime(
			(options) =>
				new AntigravityAcpConnection({
					...options,
					command: process.execPath,
					args: [fakeAgent, "headless-auth"],
				}),
		);
		let shownUrl: string | undefined;
		try {
			await runtime.loginGoogle(undefined, undefined, {
				showAuthorizationUrl(url) {
					shownUrl = url;
				},
				promptForCallback: async () => {
					if (!shownUrl) throw new Error("authorization URL was not shown");
					const authorization = new URL(shownUrl);
					const redirect = authorization.searchParams.get("redirect_uri");
					const state = authorization.searchParams.get("state");
					if (!redirect || !state) throw new Error("authorization URL is incomplete");
					return `${redirect}?state=${encodeURIComponent(state)}&code=fake-code`;
				},
			});
			expect(shownUrl).toMatch(/^https:\/\/accounts\.google\.com\//u);
		} finally {
			await runtime.close();
			if (previousMode === undefined) delete process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE;
			else process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE = previousMode;
		}
	});

	it("does not prompt when headless login reuses cached authentication", async () => {
		const previousMode = process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE;
		process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE = "manual";
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		const progress: string[] = [];
		try {
			await runtime.loginGoogle(undefined, (message) => progress.push(message), {
				showAuthorizationUrl() {
					throw new Error("cached authentication unexpectedly showed a URL");
				},
				promptForCallback: async () => {
					throw new Error("cached authentication unexpectedly prompted");
				},
			});
			expect(progress).toContain("Antigravity reused the saved Google login.");
		} finally {
			await runtime.close();
			if (previousMode === undefined) delete process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE;
			else process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE = previousMode;
		}
	});

	it("maps a complete ACP turn into balanced Pi events", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			const context: Context = {
				systemPrompt: "Be useful",
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			};
			const writer = runtime.stream(model, context, { sessionId: "pi-session", apiKey: MANAGED_AUTH_MARKER });
			const events = [];
			for await (const event of writer.stream) events.push(event);
			expect(events.map((event) => event.type)).toEqual([
				"start",
				"thinking_start",
				"thinking_delta",
				"thinking_end",
				"text_start",
				"text_delta",
				"text_end",
				"done",
			]);
			const done = events.at(-1);
			expect(done).toMatchObject({
				type: "done",
				message: { usage: { input: 7, output: 3, totalTokens: 10 }, rawStopReason: "end_turn" },
			});
			const snapshot = await runtime.snapshot();
			expect(snapshot.bindings).toBe(1);
			expect(snapshot.permissionMode).toBe("default");
			expect(snapshot.processes[0]).toMatchObject({ modelId: "gemini-test", alive: true });
			await runtime.setPermissionMode("default");
			expect((await runtime.snapshot()).permissionMode).toBe("default");
			if (done?.type !== "done") throw new Error("missing first turn");
			const switchedModel = { ...model, id: "auto", name: "Auto" };
			const second = runtime.stream(
				switchedModel,
				{
					messages: [
						...context.messages,
						done.message,
						{ role: "user", content: "second turn", timestamp: Date.now() },
					],
				},
				{ sessionId: "pi-session", apiKey: MANAGED_AUTH_MARKER },
			);
			for await (const _event of second.stream) void _event;
			const switched = await runtime.snapshot();
			expect(switched.processes[0]).toMatchObject({
				generation: snapshot.processes[0]?.generation,
				modelId: "auto",
			});
		} finally {
			await runtime.close();
		}
	});

	it("restores a persisted ACP session across runtime restarts", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-runtime-session-"));
		const store = new AcpSessionStore(path.join(directory, "sessions.json"));
		const factory = (options: ConstructorParameters<typeof AntigravityAcpConnection>[0]) =>
			new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] });
		const firstRuntime = new AntigravityRuntime(factory, "yolo", store);
		try {
			const firstContext: Context = {
				messages: [{ role: "user", content: "first", timestamp: 1 }],
			};
			const first = firstRuntime.stream(model, firstContext, { sessionId: "persisted", apiKey: MANAGED_AUTH_MARKER });
			const firstEvents = [];
			for await (const event of first.stream) firstEvents.push(event);
			const done = firstEvents.at(-1);
			if (done?.type !== "done") throw new Error("first turn did not complete");
			await firstRuntime.close();

			const secondRuntime = new AntigravityRuntime(factory, "yolo", store);
			try {
				const second = secondRuntime.stream(
					model,
					{
						messages: [
							...firstContext.messages,
							done.message,
							{ role: "user", content: "second", timestamp: 2 },
						],
					},
					{ sessionId: "persisted", apiKey: MANAGED_AUTH_MARKER },
				);
				for await (const _event of second.stream) void _event;
				expect((await secondRuntime.snapshot()).processes[0]?.restored).toBe(true);
			} finally {
				await secondRuntime.close();
			}
		} finally {
			await firstRuntime.close();
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it("recreates the ACP session when the owned Pi prefix changes", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			const first = runtime.stream(
				model,
				{ messages: [{ role: "user", content: "original", timestamp: 1 }] },
				{ sessionId: "rewind-session", apiKey: MANAGED_AUTH_MARKER },
			);
			for await (const _event of first.stream) void _event;
			const firstGeneration = (await runtime.snapshot()).processes[0]?.generation;

			const second = runtime.stream(
				model,
				{
					messages: [
						{ role: "user", content: "changed", timestamp: 1 },
						{ role: "user", content: "continue", timestamp: 2 },
					],
				},
				{ sessionId: "rewind-session", apiKey: MANAGED_AUTH_MARKER },
			);
			for await (const _event of second.stream) void _event;
			const secondGeneration = (await runtime.snapshot()).processes[0]?.generation;
			expect(secondGeneration).not.toBe(firstGeneration);
		} finally {
			await runtime.close();
		}
	});

	it.each([
		["bridge-permission", "Decision: selected:allow-once"],
		["bridge-permission-always", "Decision: cancelled"],
		["bridge-permission-unknown", "Decision: cancelled"],
	])("handles exact bridge permission without an extra Pi tool: %s", async (scenario, expected) => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent, scenario] }),
		);
		try {
			const writer = runtime.stream(model, {
				tools: [{ name: "echo", description: "Echo", parameters: Type.Object({ text: Type.String() }) }],
				messages: [{ role: "user", content: "permission", timestamp: 1 }],
			}, { sessionId: "permission-session", apiKey: MANAGED_AUTH_MARKER });
			const events = [];
			for await (const event of writer.stream) events.push(event);
			expect(events.some((event) => event.type === "toolcall_start")).toBe(false);
			expect(writer.message.content).toEqual([{ type: "text", text: expected }]);
		} finally { await runtime.close(); }
	});

	it("round-trips an MCP call through a genuine Pi tool call", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			const tools = [
				{ name: "echo", description: "Echo text", parameters: Type.Object({ text: Type.String() }) },
			];
			const firstContext: Context = {
				messages: [{ role: "user", content: "use bridge", timestamp: 1 }],
				tools,
			};
			const firstWriter = runtime.stream(model, firstContext, { apiKey: MANAGED_AUTH_MARKER });
			const firstEvents = [];
			for await (const event of firstWriter.stream) firstEvents.push(event);
			const firstDone = firstEvents.at(-1);
			if (firstDone?.type !== "done") throw new Error("missing bridged tool turn");
			expect(firstDone.reason).toBe("toolUse");
			const call = firstDone.message.content.find((block) => block.type === "toolCall");
			if (!call || call.type !== "toolCall") throw new Error("missing bridged tool call");
			expect(call).toMatchObject({ name: "echo", arguments: { text: "from gemini" } });

			const secondWriter = runtime.stream(
				model,
				{
					tools,
					messages: [
						...firstContext.messages,
						firstDone.message,
						{
							role: "toolResult",
							toolCallId: call.id,
							toolName: call.name,
							content: [{ type: "text", text: "echo result" }],
							isError: false,
							timestamp: 2,
						},
					],
				},
				{ apiKey: MANAGED_AUTH_MARKER },
			);
			const secondEvents = [];
			for await (const event of secondWriter.stream) secondEvents.push(event);
			expect(secondWriter.message.content).toEqual([{ type: "text", text: "echo result" }]);
			expect(secondEvents.at(-1)?.type).toBe("done");
		} finally {
			await runtime.close();
		}
	});

	it("batches staggered parallel MCP calls into one Pi tool turn", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			const tools = [
				{ name: "echo", description: "Echo text", parameters: Type.Object({ text: Type.String() }) },
			];
			const firstContext: Context = {
				tools,
				messages: [{ role: "user", content: "use bridge parallel", timestamp: 1 }],
			};
			const first = runtime.stream(model, firstContext, {
				sessionId: "parallel-session",
				apiKey: MANAGED_AUTH_MARKER,
			});
			const firstEvents = [];
			for await (const event of first.stream) firstEvents.push(event);
			const firstDone = firstEvents.at(-1);
			if (firstDone?.type !== "done") throw new Error("missing parallel tool turn");
			const calls = firstDone.message.content.filter((block) => block.type === "toolCall");
			expect(calls.map((call) => call.arguments.text)).toEqual(["first", "second"]);

			const toolResults = calls.map((call, index) => ({
				role: "toolResult" as const,
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text" as const, text: `result-${index + 1}` }],
				isError: false,
				timestamp: index + 2,
			}));
			const second = runtime.stream(
				model,
				{
					tools,
					messages: [...firstContext.messages, firstDone.message, ...toolResults],
				},
				{ sessionId: "parallel-session", apiKey: MANAGED_AUTH_MARKER },
			);
			for await (const _event of second.stream) void _event;
			expect(second.message.content).toEqual([{ type: "text", text: "result-1,result-2" }]);
		} finally {
			await runtime.close();
		}
	});

	it("honors cancellation on an MCP continuation stream", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			const tools = [
				{ name: "echo", description: "Echo text", parameters: Type.Object({ text: Type.String() }) },
			];
			const firstContext: Context = {
				tools,
				messages: [{ role: "user", content: "use bridge delayed", timestamp: 1 }],
			};
			const first = runtime.stream(model, firstContext, {
				sessionId: "continuation-abort",
				apiKey: MANAGED_AUTH_MARKER,
			});
			const firstEvents = [];
			for await (const event of first.stream) firstEvents.push(event);
			const firstDone = firstEvents.at(-1);
			if (firstDone?.type !== "done") throw new Error("missing tool call turn");
			const call = firstDone.message.content.find((block) => block.type === "toolCall");
			if (!call || call.type !== "toolCall") throw new Error("missing tool call");

			const controller = new AbortController();
			const second = runtime.stream(
				model,
				{
					tools,
					messages: [
						...firstContext.messages,
						firstDone.message,
						{
							role: "toolResult",
							toolCallId: call.id,
							toolName: call.name,
							content: [{ type: "text", text: "result" }],
							isError: false,
							timestamp: 2,
						},
					],
				},
				{ sessionId: "continuation-abort", apiKey: MANAGED_AUTH_MARKER, signal: controller.signal },
			);
			setTimeout(() => controller.abort(), 30);
			const secondEvents = [];
			for await (const event of second.stream) secondEvents.push(event);
			expect(secondEvents.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
			expect((await runtime.snapshot()).processes[0]?.alive).toBe(true);
		} finally {
			await runtime.close();
		}
	});

	it("cancels an ACP prompt while preserving a healthy warm binding", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			const controller = new AbortController();
			const writer = runtime.stream(
				model,
				{ messages: [{ role: "user", content: "hang", timestamp: 1 }] },
				{ sessionId: "abort-session", apiKey: MANAGED_AUTH_MARKER, signal: controller.signal },
			);
			await runtime.snapshot();
			controller.abort();
			const events = [];
			for await (const event of writer.stream) events.push(event);
			expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
			const snapshot = await runtime.snapshot();
			expect(snapshot.bindings).toBe(1);
			expect(snapshot.processes[0]?.alive).toBe(true);
		} finally {
			await runtime.close();
		}
	});
});
