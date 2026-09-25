import { afterEach, expect, it as test } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink, rename } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AntigravityProcess } from "../src/acp/process.js";

// This opt-in supervisor is qualified only for the fixed macOS interpreter.
const it = process.platform === "darwin" ? test : test.skip;
const script = fileURLToPath(new URL("../src/acp/history-supervisor.py", import.meta.url));
const homes: string[] = [];
const children: AntigravityProcess[] = [];
afterEach(async () => {
 await Promise.all(children.splice(0).map(child => child.close()));
 await Promise.all(homes.splice(0).map(home => rm(home, { recursive:true, force:true })));
});
async function fixture() {
 const home = await mkdtemp(path.join(tmpdir(), "acp-history-")); homes.push(home);
 const profile = path.join(home, "antigravity-acp");
 for (const name of ["conversations", "brain", "../artifacts"]) await mkdir(path.join(profile, name), {recursive:true});
 for (const name of ["acp_token.json", "settings.json", "unrelated"]) await writeFile(path.join(profile,name), `sentinel:${name}`);
 await writeFile(path.join(home,"artifacts","keep"), "shared");
 return {home, profile};
}
function launch(home:string, code:string) {
 const child = new AntigravityProcess({cwd:process.cwd(), command:"/usr/bin/python3", args:["-I","-B",script,"--command",process.execPath,"-e",code],env:{...process.env,GEMINI_HOME:home}, shutdownGraceMs:10000});
 children.push(child); return child;
}
async function ready(child:AntigravityProcess) {
 await new Promise<void>((resolve,reject) => {
 const timer = setTimeout(()=>reject(new Error(`not ready: ${child.stderrTail}`)),7000);
 child.child.stdout.on("data",chunk=>{ if(chunk.toString().includes("READY")){clearTimeout(timer);resolve();} });
 child.exited.then(exit=>{clearTimeout(timer);reject(new Error(`early exit: ${JSON.stringify(exit)}`));});
 });
}
const writer = (id:string) => `const fs=require('fs'); const p=process.env.GEMINI_HOME+'/antigravity-acp'; fs.writeFileSync(p+'/conversations/${id}.db','history'); fs.mkdirSync(p+'/brain/${id}'); fs.writeFileSync(p+'/brain/${id}/data','history'); console.log('READY'); setInterval(()=>{},1000);`;
it("cleans owned history after close and preserves credentials and unrelated files", async()=>{
 const {home,profile}=await fixture(); const child=launch(home,writer("one")); await ready(child); await child.close();
 expect((await child.exited).code).toBe(0);
 expect(await readdir(path.join(profile,"conversations"))).toEqual([]); expect(await readdir(path.join(profile,"brain"))).toEqual([]);
 for(const name of ["acp_token.json","settings.json","unrelated"]) expect(await readFile(path.join(profile,name),"utf8")).toBe(`sentinel:${name}`);
 expect(await readFile(path.join(home,"artifacts","keep"),"utf8")).toBe("shared");
},15000);
it("keeps concurrent runtimes active and delays cleanup until the last exits",async()=>{
 const {home,profile}=await fixture(); const a=launch(home,writer("a")); await ready(a); const b=launch(home,writer("b")); await ready(b);
 await a.close(); expect(await readdir(path.join(profile,"conversations"))).toEqual(expect.arrayContaining(["a.db","b.db"]));
 await b.close(); expect(await readdir(path.join(profile,"conversations"))).toEqual([]);
},20000);
it("removes pre-response startup history after a runtime failure",async()=>{
 const {home,profile}=await fixture(); const child=launch(home,writer("failed").replace("setInterval(()=>{},1000);","process.exit(23);"));
 const exit=await child.exited; expect(exit.code).toBe(23); expect(await readdir(path.join(profile,"conversations"))).toEqual([]);
},15000);

async function until(check:()=>Promise<boolean>, ms=5000) {
 const end=Date.now()+ms;
 while(Date.now()<end) { if(await check()) return; await new Promise(resolve=>setTimeout(resolve,25)); }
 throw new Error("condition timed out");
}
function processAlive(pid:number) { try {process.kill(pid,0);return true;} catch {return false;} }
it("unlinks nested symlinks without touching their targets",async()=>{
 const {home,profile}=await fixture(); const outside=path.join(home,"outside"); await mkdir(outside); await writeFile(path.join(outside,"keep"),"safe");
 await symlink(outside,path.join(profile,"brain","link"));
 const child=launch(home,writer("safe")); await ready(child); await child.close();
 expect(await readFile(path.join(outside,"keep"),"utf8")).toBe("safe"); expect(await readdir(path.join(profile,"brain"))).toEqual([]);
},15000);
it("refuses a symlinked history root before deleting either history root",async()=>{
 const {home,profile}=await fixture(); await writeFile(path.join(profile,"conversations","keep.db"),"safe");
 await rename(path.join(profile,"brain"),path.join(home,"outside")); await symlink(path.join(home,"outside"),path.join(profile,"brain"));
 const child=launch(home,"process.exit(0)"); expect((await child.exited).code).toBe(75);
 expect(await readFile(path.join(profile,"conversations","keep.db"),"utf8")).toBe("safe");
},10000);
it("fails closed on corrupt records without launching or deleting history",async()=>{
 const {home,profile}=await fixture(); const coord=path.join(profile,".pi-history-cleanup"); await mkdir(coord,{mode:0o700});
 await writeFile(path.join(coord,"a".repeat(32)+".json"),"broken"); await writeFile(path.join(profile,"conversations","keep.db"),"safe");
 const child=launch(home,writer("never")); expect((await child.exited).code).toBe(75);
 expect(await readdir(path.join(profile,"conversations"))).toEqual(["keep.db"]);
},10000);
it("a live or reused owner conservatively blocks cleanup without blocking concurrency",async()=>{
 const {home,profile}=await fixture(); const coord=path.join(profile,".pi-history-cleanup"); await mkdir(coord,{mode:0o700});
 await writeFile(path.join(coord,"b".repeat(32)+".json"),JSON.stringify({version:1,supervisor:process.pid,group:null}));
 await writeFile(path.join(profile,"conversations","keep.db"),"safe"); const child=launch(home,writer("owned")); await ready(child); await child.close();
 expect(await readdir(path.join(profile,"conversations"))).toEqual(expect.arrayContaining(["keep.db","owned.db"]));
 expect(processAlive(process.pid)).toBe(true);
},15000);
it("gate EOF before START never launches ACP",async()=>{
 const {home,profile}=await fixture();
 const runner=spawn("/usr/bin/python3",["-I","-B",script,"--runner","3","--command",process.execPath,"-e",writer("never")],{env:{...process.env,GEMINI_HOME:home},stdio:["ignore","ignore","pipe","pipe"]});
 const exited=new Promise(resolve=>runner.once("exit",resolve));
 (runner.stdio[3] as import("node:stream").Writable).end(); expect(await exited).toBe(0); expect(await readdir(path.join(profile,"conversations"))).toEqual([]);
},10000);
it("recovers after supervisor SIGKILL and clears unreturned history on next launch",async()=>{
 const {home,profile}=await fixture(); const child=launch(home,writer("crashed")); await ready(child);
 const coord=path.join(profile,".pi-history-cleanup"); const name=(await readdir(coord)).find(name=>name.endsWith(".json"))!;
 const lease=JSON.parse(await readFile(path.join(coord,name),"utf8")); expect(lease.group).toBeGreaterThan(1);
 process.kill(child.pid!,"SIGKILL"); await child.exited;
 await until(async()=>{try {process.kill(-lease.group,0);return false;}catch{return true;}},5000);
 expect(await readdir(path.join(profile,"conversations"))).toContain("crashed.db");
 const next=launch(home,writer("next")); await ready(next); expect(await readdir(path.join(profile,"conversations"))).toEqual(["next.db"]); await next.close();
 expect(await readdir(path.join(profile,"conversations"))).toEqual([]);
},20000);
it("waits for and kills a surviving descendant after the ACP leader exits",async()=>{
 const {home,profile}=await fixture();
 const code=`const fs=require('fs'),cp=require('child_process'); const c=cp.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('UP');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});c.stdout.once('data',()=>{fs.writeFileSync(process.env.GEMINI_HOME+'/descendant',String(c.pid));process.exit(0)});`;
 const child=launch(home,code); const exit=await child.exited; expect(exit.code,exit.stderrTail).toBe(0);
 const pid=Number(await readFile(path.join(home,"descendant"),"utf8")); expect(processAlive(pid)).toBe(false);
 expect(await readdir(path.join(profile,"conversations"))).toEqual([]);
},15000);
it("close waits through lock contention, reports deferral, and recovers on next launch",async()=>{
 const {home,profile}=await fixture(); const child=launch(home,writer("blocked")); await ready(child);
 const lock=path.join(profile,".pi-history-cleanup","lock");
 const holder=spawn("/usr/bin/python3",["-I","-B","-c","import fcntl,sys,time; f=open(sys.argv[1],'r+'); fcntl.flock(f,fcntl.LOCK_EX); print('LOCKED',flush=True); time.sleep(12)",lock]);
 try {
 await new Promise<void>(resolve=>holder.stdout.once("data",()=>resolve()));
 const start=Date.now(); await child.close(); const exit=await child.exited;
 expect(Date.now()-start).toBeGreaterThan(4500); expect(Date.now()-start).toBeLessThan(10000);
 expect(exit.code).toBe(75); expect(exit.stderrTail).toContain("admission lock timed out");
 expect(await readdir(path.join(profile,"conversations"))).toContain("blocked.db");
 } finally {holder.kill("SIGKILL");await new Promise(resolve=>holder.once("exit",resolve));}
 const next=launch(home,writer("next")); await ready(next); await next.close(); expect(await readdir(path.join(profile,"conversations"))).toEqual([]);
},20000);

it("registers the runtime group before the first runtime instruction",async()=>{
 const {home}=await fixture();
 const code=`const fs=require('fs'),p=process.env.GEMINI_HOME+'/antigravity-acp/.pi-history-cleanup'; const records=fs.readdirSync(p).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(p+'/'+n)));process.exit(records.some(r=>r.group===process.ppid)?0:42);`;
 const child=launch(home,code); expect((await child.exited).code).toBe(0);
},10000);
it("cleans history after the controlling process disappears",async()=>{
 const {home,profile}=await fixture();
 const code=`const fs=require('fs'),cp=require('child_process');const c=cp.spawn('/usr/bin/python3',['-I','-B',${JSON.stringify(script)},'--command',process.execPath,'-e',${JSON.stringify(writer("controller"))}],{env:process.env}); fs.writeFileSync(process.env.GEMINI_HOME+'/supervisor',String(c.pid));c.stdout.pipe(process.stdout);c.stderr.pipe(process.stderr);`;
 const controller=spawn(process.execPath,["-e",code],{env:{...process.env,GEMINI_HOME:home}});
 try {
 await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("controller not ready")),7000);controller.stdout.on("data",chunk=>{if(chunk.toString().includes("READY")){clearTimeout(timer);resolve();}});});
 controller.kill("SIGKILL");
 await until(async()=> (await readdir(path.join(profile,"conversations"))).length===0);
 const supervisor=Number(await readFile(path.join(home,"supervisor"),"utf8")); await until(async()=>!processAlive(supervisor));
 } finally {controller.kill("SIGKILL");}
},15000);
it("serializes admission against final cleanup without serializing runtime lifetimes",async()=>{
 const {home,profile}=await fixture(); const a=launch(home,writer("first")); await ready(a);
 const lock=path.join(profile,".pi-history-cleanup","lock");
 const holder=spawn("/usr/bin/python3",["-I","-B","-c","import fcntl,sys; f=open(sys.argv[1],'r+'); fcntl.flock(f,fcntl.LOCK_EX); print('LOCKED',flush=True); sys.stdin.read()",lock]);
 try {
 await new Promise<void>(resolve=>holder.stdout.once("data",()=>resolve()));
 const closed=a.close(); const b=launch(home,writer("second")); const started=ready(b);
 await new Promise(resolve=>setTimeout(resolve,100)); holder.stdin.end();
 await Promise.all([closed,started]); expect(await readdir(path.join(profile,"conversations"))).toContain("second.db");
 await b.close(); expect(await readdir(path.join(profile,"conversations"))).toEqual([]);
 } finally {holder.kill("SIGKILL");}
},15000);

it("refuses cleanup after the profile is renamed and replaced",async()=>{
 const {home,profile}=await fixture(); const child=launch(home,writer("moved")); await ready(child);
 const moved=path.join(home,"moved-profile"); await rename(profile,moved); await mkdir(profile);
 await child.close(); const exit=await child.exited;
 expect(exit.code).toBe(75); expect(await readFile(path.join(moved,"conversations","moved.db"),"utf8")).toBe("history");
},15000);
it("refuses cleanup when the stable lock inode has been replaced",async()=>{
 const {home,profile}=await fixture(); const child=launch(home,writer("locked")); await ready(child);
 const lock=path.join(profile,".pi-history-cleanup","lock"); await rename(lock,path.join(home,"old-lock")); await writeFile(lock,"");
 await child.close(); expect((await child.exited).code).toBe(75); expect(await readdir(path.join(profile,"conversations"))).toContain("locked.db");
},15000);
it("does not reap its group leader before sending the final group signal",async()=>{
 const code=`import importlib.util,sys\nspec=importlib.util.spec_from_file_location('history',sys.argv[1]); m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nevents=[]\nm.signal_group=lambda pid,sig: events.append('signal')\nm.alive=lambda *args,**kwargs: events.count('signal') < 2\nclass Runner:\n pid=999999\n def poll(self): events.append('reap');return 0\n def wait(self,**kwargs): events.append('reap');return 0\nm.drain(Runner())\nassert 'signal' in events and 'reap' in events\nassert max(i for i,e in enumerate(events) if e=='signal') < min(i for i,e in enumerate(events) if e=='reap'), events\n`;
 const probe=spawn("/usr/bin/python3",["-I","-B","-c",code,script]); let error="";probe.stderr.on("data",chunk=>{error+=chunk.toString();});
 expect(await new Promise(resolve=>probe.once("exit",resolve)),error).toBe(0);
},10000);


it("forwards input and output bytes without protocol alteration",async()=>{
 const {home}=await fixture(); const child=launch(home,"console.log('READY');process.stdin.on('data',chunk=>process.stdout.write(chunk));"); await ready(child);
 const payload=Buffer.from(JSON.stringify({jsonrpc:"2.0",id:1,method:"session/prompt",text:"π".repeat(10000)})+"\n");
 const echoed=new Promise<Buffer>((resolve,reject)=>{let data=Buffer.alloc(0); const timer=setTimeout(()=>reject(new Error("echo timed out")),5000); child.child.stdout.on("data",chunk=>{data=Buffer.concat([data,chunk]);if(data.length>=payload.length){clearTimeout(timer);resolve(data);}});});
 child.child.stdin.write(payload); expect(await echoed).toEqual(payload); await child.close();
},15000);
it("refuses cleanup after a history root is renamed and replaced",async()=>{
 const {home,profile}=await fixture(); const child=launch(home,writer("moved")); await ready(child);
 await rename(path.join(profile,"brain"),path.join(home,"moved-brain")); await mkdir(path.join(profile,"brain"));
 await child.close(); expect((await child.exited).code).toBe(75);
 expect(await readFile(path.join(home,"moved-brain","moved","data"),"utf8")).toBe("history");
 expect(await readdir(path.join(profile,"conversations"))).toContain("moved.db");
},15000);
it("refuses cleanup after its coordination directory is renamed and replaced",async()=>{
 const {home,profile}=await fixture(); const child=launch(home,writer("coord")); await ready(child);
 await rename(path.join(profile,".pi-history-cleanup"),path.join(home,"old-coord")); await mkdir(path.join(profile,".pi-history-cleanup"),{mode:0o700});
 await child.close(); expect((await child.exited).code).toBe(75); expect(await readdir(path.join(profile,"conversations"))).toContain("coord.db");
},15000);

it("drains descendants when the supervisor disappears during the gate status report",async()=>{
 const {home}=await fixture();
 const code=`const fs=require('fs'),cp=require('child_process');const child=cp.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('UP');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});child.stdout.once('data',()=>{fs.writeFileSync(process.env.GEMINI_HOME+'/orphan',String(child.pid));process.exit(0)});`;
 const runner=spawn("/usr/bin/python3",["-I","-B",script,"--runner","3","4","--command",process.execPath,"-e",code],{env:{...process.env,GEMINI_HOME:home},detached:true,stdio:["ignore","ignore","pipe","pipe","pipe"]});
 const exited=new Promise(resolve=>runner.once("exit",resolve)); let orphan:number|undefined;
 try {
 (runner.stdio[4] as import("node:stream").Duplex).destroy();
 (runner.stdio[3] as import("node:stream").Writable).write("START\n");
 await until(async()=>{try{orphan=Number(await readFile(path.join(home,"orphan"),"utf8"));return true;}catch{return false;}});
 await exited; await until(async()=>!processAlive(orphan!),2000); expect(processAlive(orphan!)).toBe(false);
 } finally {
 if(orphan && processAlive(orphan)) process.kill(orphan,"SIGKILL");
 (runner.stdio[3] as import("node:stream").Writable).end();
 if(runner.exitCode===null && runner.signalCode===null) runner.kill("SIGKILL");
 }
},10000);

it("reports a dead owner's surviving group and never signals it",async()=>{
 const {home,profile}=await fixture(); const coord=path.join(profile,".pi-history-cleanup"); await mkdir(coord,{mode:0o700});
 const survivor=spawn(process.execPath,["-e","console.log('READY');setInterval(()=>{},1000)"],{detached:true});
 const exited=new Promise(resolve=>survivor.once("exit",resolve));
 try {
 await new Promise<void>(resolve=>survivor.stdout.once("data",()=>resolve()));
 const name="c".repeat(32)+".json";
 await writeFile(path.join(coord,name),JSON.stringify({version:1,supervisor:2147483647,group:survivor.pid}));
 await writeFile(path.join(profile,"conversations","keep.db"),"safe");
 const child=launch(home,"process.exit(0)"); const exit=await child.exited;
 expect(exit.code).toBe(75); expect(exit.stderrTail).toContain("recorded runtime group remains present");
 expect(await readFile(path.join(profile,"conversations","keep.db"),"utf8")).toBe("safe");
 expect(await readdir(coord)).toContain(name); expect(processAlive(survivor.pid!)).toBe(true);
 } finally {survivor.kill("SIGKILL");await exited;}
},10000);
