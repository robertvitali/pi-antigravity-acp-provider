import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { qualifiedRuntime, installQualifiedRuntime, resolveQualifiedRuntime } from "../src/acp/setup.js";

describe("qualified subscription runtime", () => {
 it("selects the verified Google release independently of upstream rolling manifests", () => {
  const release = qualifiedRuntime("darwin-aarch64");
  expect(release.version).toBe("1.2.1");
  expect(release.archiveSha256).toBe("0fab9938812e6b32b3b543e65e4f3a0025ceef755413db13542d9a9b81ea803c");
  expect(release.archiveBytes).toBe(111725488);
  expect(new URL(release.archive).hostname).toBe("dl.google.com");
 });
 it("fails closed on unqualified platforms", () => {
  expect(() => qualifiedRuntime("linux-x86_64")).toThrow(/not qualified/);
 });
});

it("refuses an installed unqualified newer release without downloading", async () => {
 const home = fs.mkdtempSync(path.join(os.tmpdir(), "acp-qualified-"));
 const current = path.join(home, ".local/opt/agy-acp/current");
 fs.mkdirSync(current, { recursive: true });
 fs.writeFileSync(path.join(current, "agy_acp_server.par"), "fake", { mode: 0o700 });
 fs.writeFileSync(path.join(current, "install-integrity.json"), JSON.stringify({
  version: "9.0.0", platform: "darwin-aarch64", archiveSha256: "unqualified",
  binaryName: "agy_acp_server.par", binaryBytes: 4, harnessName: "localharness_external"
 }));
 const homeMock = vi.spyOn(os, "homedir").mockReturnValue(home);
 const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
 try {
  await expect(installQualifiedRuntime()).rejects.toThrow(/unqualified newer runtime/);
  expect(fetchMock).not.toHaveBeenCalled();
 } finally { homeMock.mockRestore(); vi.unstubAllGlobals(); fs.rmSync(home, { recursive: true, force: true }); }
});

it("resolves only the qualified immutable install, ignoring ambient binaries", () => {
 const home = fs.mkdtempSync(path.join(os.tmpdir(), "acp-resolve-"));
 const homeMock = vi.spyOn(os, "homedir").mockReturnValue(home);
 vi.stubEnv("AGY_ACP_BIN", process.execPath);
 try {
  expect(() => resolveQualifiedRuntime()).toThrow(/qualified runtime is not installed/);
 } finally { homeMock.mockRestore(); vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); }
});
