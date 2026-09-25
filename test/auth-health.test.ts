import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	clearAntigravityCredentials,
	inspectAntigravityAuth,
} from "../src/acp/antigravity.js";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function root(): string {
	const value = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-auth-"));
	roots.push(value);
	return value;
}

describe("Antigravity auth health", () => {
	it("does not mistake settings alone for completed authentication", () => {
		const directory = root();
		fs.writeFileSync(path.join(directory, "settings.json"), '{"auth":{"type":"oauth-personal"}}');
		expect(inspectAntigravityAuth(directory).status).toBe("configured-not-authenticated");
	});

	it("recognizes a structurally refreshable token and clears it", () => {
		const directory = root();
		fs.writeFileSync(path.join(directory, "settings.json"), '{"auth":{"type":"oauth-personal"}}');
		fs.writeFileSync(path.join(directory, "acp_token.json"), '{"refresh_token":"secret"}');
		expect(inspectAntigravityAuth(directory).status).toBe("oauth-refreshable");
		clearAntigravityCredentials(directory);
		expect(inspectAntigravityAuth(directory).status).toBe("missing");
	});

	it("reports corrupt token files", () => {
		const directory = root();
		fs.writeFileSync(path.join(directory, "acp_token.json"), "not-json");
		expect(inspectAntigravityAuth(directory).status).toBe("corrupt");
	});
});

 it("ignores ambient API keys and rejects non-personal auth", () => {
  const directory = root();
  vi.stubEnv("GEMINI_API_KEY", "not-a-real-key");
  expect(inspectAntigravityAuth(directory).status).toBe("missing");
  fs.writeFileSync(path.join(directory, "settings.json"), '{"auth":{"type":"oauth-business"}}');
  fs.writeFileSync(path.join(directory, "acp_token.json"), '{"refresh_token":"fixture"}');
  expect(inspectAntigravityAuth(directory).status).not.toBe("oauth-refreshable");
 });

it("uses the runtime's GEMINI_HOME and requires explicit personal auth", () => {
 const home = root();
 vi.stubEnv("GEMINI_HOME", home);
 const directory = path.join(home, "antigravity-acp");
 fs.mkdirSync(directory);
 fs.writeFileSync(path.join(directory, "acp_token.json"), '{"refresh_token":"fixture"}');
 expect(inspectAntigravityAuth().status).not.toBe("oauth-refreshable");
 fs.writeFileSync(path.join(directory, "settings.json"), '{"auth":{"type":"oauth-personal"}}');
 expect(inspectAntigravityAuth().status).toBe("oauth-refreshable");
});
