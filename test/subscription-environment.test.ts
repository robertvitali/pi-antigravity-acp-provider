import { expect, it } from "vitest";
import { AntigravityProcess } from "../src/acp/process.js";

it("removes API credentials and endpoint overrides from child environments", async () => {
 const child = new AntigravityProcess({
  cwd: process.cwd(), command: process.execPath,
  args: ["-e", "console.log(JSON.stringify(Object.keys(process.env).filter(k=>/^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|AGY_ACP_CCPA_BASE_URL|NODE_OPTIONS|PYTHONPATH)$/.test(k))))"],
  env: { ...process.env, GEMINI_API_KEY:"fixture", GOOGLE_API_KEY:"fixture", GOOGLE_APPLICATION_CREDENTIALS:"fixture", GOOGLE_CLOUD_PROJECT:"fixture", AGY_ACP_CCPA_BASE_URL:"http://invalid.test", NODE_OPTIONS:"", PYTHONPATH:"fixture" }
 });
 let output="";
 child.child.stdout.on("data", chunk=>{output+=chunk.toString();});
 try { await child.exited; expect(JSON.parse(output)).toEqual([]); }
 finally { await child.close(); }
});
