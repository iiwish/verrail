import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAcpxEngineExecutor } from "./execute.js";

const keys = ["VERRAIL_DOMAIN_API_TOKEN", "verrail_github_ci_proof_token", "ACPX_AUTH_VERRAIL_DOMAIN_API_TOKEN", "acpx_auth_verrail_github_ci_proof_token"];
afterEach(() => vi.unstubAllEnvs());

it("keeps control-plane tokens out of real ACP agents, terminal/create and persisted restart state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "verrail-acpx-env-"));
  try {
    for (const key of keys) vi.stubEnv(key, "fixture-inherited-control-credential");
    const script = path.join(root, "agent.mjs");
    await fs.writeFile(script, `import {createInterface} from 'node:readline';
const keys=${JSON.stringify(keys)}; let seq=1000; const waiting=new Map();
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
const call=(method,params)=>new Promise((resolve,reject)=>{const id=seq++;waiting.set(id,{resolve,reject});send({jsonrpc:'2.0',id,method,params});});
const observed=()=>Object.fromEntries([...keys,'OPENAI_API_KEY','PAPERCLIP_API_KEY'].map(k=>[k,process.env[k]??null]));
createInterface({input:process.stdin}).on('line',async line=>{const m=JSON.parse(line);if(!m.method){const p=waiting.get(m.id);if(p){waiting.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}return;}
try{let result={}; if(m.method==='initialize') result={protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{close:{}}},agentInfo:{name:'env-fixture',version:'1'}};
else if(m.method==='session/new'||m.method==='session/load') result={sessionId:'env-fixture-session'};
else if(m.method==='session/prompt'){ const sessionId=m.params.sessionId;
const terminal=await call('terminal/create',{sessionId,command:process.execPath,args:['-e',${JSON.stringify(`process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k=>[k,process.env[k]??null]))))`)}],env:keys.map(name=>({name,value:'fixture-terminal-reinjection'}))});
await call('terminal/wait_for_exit',{sessionId,terminalId:terminal.terminalId});const output=await call('terminal/output',{sessionId,terminalId:terminal.terminalId});await call('terminal/release',{sessionId,terminalId:terminal.terminalId});
send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ENV_RESULT:'+JSON.stringify({agent:observed(),terminal:JSON.parse(output.output)})}}}});result={stopReason:'end_turn'};}
if(m.id!==undefined)send({jsonrpc:'2.0',id:m.id,result});}catch(error){if(m.id!==undefined)send({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:String(error.message)}});}});
`);
    const stateDir = path.join(root, "state");
    const config = { agent: "custom", agentCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
      mode: "persistent", warmHandleIdleMs: 0, stateDir, cwd: root,
      env: { ...Object.fromEntries(keys.map(key => [key, "fixture-config-reinjection"])), OPENAI_API_KEY: "fixture-model-key" } };
    let sessionParams: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const logs: string[] = [];
      const execute = createAcpxEngineExecutor();
      const result = await execute({ runId: `env-run-${attempt}`, agent: { id: "env-agent", companyId: "env-company" },
        runtime: { sessionParams }, config, context: {}, authToken: "fixture-run-key",
        onLog: async (_stream: string, text: string) => logs.push(text), onMeta: async () => {} } as never);
      expect(result.exitCode, JSON.stringify({ result, logs })).toBe(0);
      const messages: string[] = [];
      const visit = (value: unknown) => {
        if (typeof value === "string" && value.startsWith("ENV_RESULT:")) messages.push(value.slice("ENV_RESULT:".length));
        else if (value && typeof value === "object") Object.values(value).forEach(visit);
      };
      for (const line of logs.join("").split("\n")) {
        try { visit(JSON.parse(line)); } catch { visit(line); }
      }
      expect(messages, logs.join("\n")).not.toHaveLength(0);
      const observed = JSON.parse(messages.at(-1)!);
      for (const key of keys) { expect(observed.agent[key]).toBeNull(); expect(observed.terminal[key]).toBeNull(); }
      expect(observed.agent.OPENAI_API_KEY).toBe("fixture-model-key");
      expect(observed.agent.PAPERCLIP_API_KEY).toBe("fixture-run-key");
      sessionParams = result.sessionParams;
    }
    const readTree = async (dir: string): Promise<string> => {
      let result = "";
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        result += entry.isDirectory() ? await readTree(path.join(dir, entry.name)) : await fs.readFile(path.join(dir, entry.name), "utf8");
      }
      return result;
    };
    expect(await readTree(stateDir)).not.toMatch(/fixture-inherited-control-credential|fixture-config-reinjection|fixture-terminal-reinjection/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 20000);
