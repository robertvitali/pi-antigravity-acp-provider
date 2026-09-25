import { describe, expect, it } from "vitest";

import { projectModels, resolveAcpModelId } from "../src/models.js";
import { createAntigravityProvider } from "../src/provider.js";

describe("projectModels", () => {
	it("deduplicates and rejects unsafe ids", () => {
		const models = projectModels([
			{ modelId: "gemini-a", name: "Gemini A" },
			{ modelId: "gemini-a", name: "duplicate" },
			{ modelId: "bad\nmodel", name: "bad" },
		]);
		expect(models.map((model) => model.id)).toEqual(["gemini-a"]);
		expect(models[0]?.cost.input).toBe(0);
	});

	it("collapses ACP effort variants into Pi reasoning levels", () => {
		const models = projectModels([
			{ modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
			{ modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
			{ modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
			{ modelId: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)" },
			{ modelId: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
		]);

		expect(models.map((model) => model.id)).toEqual(["gemini-3.8-flash", "gemini-3.1-pro"]);
		expect(models[0]?.thinkingLevelMap?.off).toBeNull();
		expect(models[0]?.thinkingLevelMap?.medium).toBe("gemini-3.8-flash-medium");
		expect(resolveAcpModelId(models[0]!, "low")).toBe("gemini-3.8-flash-low");
		expect(resolveAcpModelId(models[0]!, "high")).toBe("gemini-3.8-flash-high");
		expect(models[1]?.thinkingLevelMap?.medium).toBeNull();
		expect(resolveAcpModelId(models[1]!, "medium")).toBe("gemini-pro-agent");
	});

	it("registers only Google-account login", async () => {
		const { provider, runtime } = createAntigravityProvider();
		try {
			expect(provider.auth.oauth?.loginLabel).toBe("Sign in with Google");
			expect(provider.auth.apiKey).toBeUndefined();
		} finally {
			await runtime.close();
		}
	});
});
