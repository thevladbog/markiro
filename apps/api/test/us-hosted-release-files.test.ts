import { beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

let output: unknown;
beforeAll(() => {
  const file = resolve(__dirname, "../src/deployment/us-hosted-release-files.ts");
  expect(existsSync(file)).toBe(true);
  const moduleSource = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  }).outputText;
  const setup = `
    const fs = require('node:fs');
    for (const [name,mode] of [['good',0o440],['writable',0o660],['unreadable',0o400]]) {
      const path='/app/apps/api/dist/'+name+'.bin';
      fs.writeFileSync(path,Buffer.from([0,255,1]));fs.chownSync(path,0,10001);fs.chmodSync(path,mode);
    }
    fs.mkdirSync('/app/node_modules/.pnpm/fflate@0.8.3/node_modules/fflate',{recursive:true});
    fs.writeFileSync('/app/node_modules/.pnpm/fflate@0.8.3/node_modules/fflate/package.json',JSON.stringify({name:'fflate',version:'0.8.3',main:'index.cjs'}),{mode:0o444});
    fs.writeFileSync('/app/node_modules/.pnpm/fflate@0.8.3/node_modules/fflate/index.cjs','module.exports={}',{mode:0o444});
    fs.symlinkSync('.pnpm/fflate@0.8.3/node_modules/fflate','/app/node_modules/fflate');
    fs.writeFileSync('/app/apps/api/dist/importer.cjs','',{mode:0o444});
    fs.mkdirSync('/app/node_modules/@react-pdf',{recursive:true});
    fs.symlinkSync('/etc','/app/node_modules/@react-pdf/renderer');
    fs.mkdirSync('/app/node_modules/.pnpm/cycle/node_modules',{recursive:true});
    fs.symlinkSync('/app/node_modules/.pnpm/cycle/node_modules/write-excel-file','/app/node_modules/.pnpm/cycle/node_modules/write-excel-file');
    fs.symlinkSync('.pnpm/cycle/node_modules/write-excel-file','/app/node_modules/write-excel-file');
    fs.symlinkSync('/app/apps/api/dist/good.bin','/app/apps/api/dist/link.bin');
    fs.mkdirSync('/app/apps/api/dist/mutable');fs.chmodSync('/app/apps/api/dist/mutable',0o777);
    fs.writeFileSync('/app/apps/api/dist/mutable/file.bin','x',{mode:0o444});
  `;
  const exercise = `
    const fs=require('node:fs');
    const {UsHostedReleaseFiles}=require('/app/apps/api/dist/reader.cjs');
    (async()=>{
      const reader=new UsHostedReleaseFiles();const before=fs.readdirSync('/proc/self/fd').length;
      const good=await reader.read('apps/api/dist/good.bin',3);
      const result=[Number(good.equals(Buffer.from([0,255,1])))];
      for(const [path,max] of [['apps/api/dist/good.bin',2],['apps/api/dist/link.bin',3],['apps/api/dist/writable.bin',3],['apps/api/dist/unreadable.bin',3],['apps/api/dist/mutable/file.bin',3],['../escape',3],['/etc/passwd',32]]){
        const refused=new UsHostedReleaseFiles();try{await refused.read(path,max);result.push(0);}catch(e){result.push(Number(e instanceof Error&&e.message==='us_hosted_release_file_invalid'));}finally{refused.dispose();}
      }
      const captured=await reader.capturePackage('apps/api/dist/importer.cjs','fflate');
      result.push(Number(captured.owner==='/app/node_modules/.pnpm/fflate@0.8.3/node_modules/fflate'&&captured.entry===captured.owner+'/index.cjs'&&JSON.parse(captured.metadata.toString('utf8')).version==='0.8.3'));
      for(const [importer,name] of [['apps/api/dist/importer.cjs','@react-pdf/renderer'],['apps/api/dist/importer.cjs','write-excel-file'],['/etc/passwd','fflate'],['apps/api/dist/importer.cjs','node:fs']]){
        const denied=new UsHostedReleaseFiles();try{await denied.capturePackage(importer,name);result.push(0);}catch(e){result.push(Number(e instanceof Error&&e.message==='us_hosted_release_file_invalid'));}finally{denied.dispose();}
      }
      await reader.assertUnchanged();reader.dispose();
      try{await reader.read('apps/api/dist/good.bin',3);result.push(0);}catch{result.push(1);}
      result.push(Number(fs.readdirSync('/proc/self/fd').length===before));
      console.log(JSON.stringify(result));
    })().catch(()=>{process.stderr.write('fixture_exercise_failed');process.exitCode=1;});
  `;
  output = JSON.parse(
    execFileSync(
      process.execPath,
      [resolve(__dirname, "support/us-hosted-installed-fixture.mjs")],
      {
        input: JSON.stringify({ moduleSource, setup, exercise }),
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ),
  );
});
it("reads only protected fixed-root bytes as a nonroot installed process and closes handles", () => {
  expect(output).toEqual({ result: Array(15).fill(1), created: 1, removed: 1 });
});

let inventoryOutput: unknown;
let extraOutput: unknown;
function inventoryFixture(extra: boolean): unknown {
  const moduleSource = ts.transpileModule(
    readFileSync(resolve(__dirname, "../src/deployment/us-hosted-release-files.ts"), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } },
  ).outputText;
  const setup = `const fs=require('node:fs');fs.writeFileSync('/app/apps/api/dist/good.bin','x',{mode:0o444});${extra ? "fs.writeFileSync('/app/unlisted.bin','x',{mode:0o444});" : ""}`;
  const exercise = `const {UsHostedReleaseFiles}=require('/app/apps/api/dist/reader.cjs');(async()=>{const reader=new UsHostedReleaseFiles();try{const files=await reader.inventory();await reader.assertUnchanged();console.log(JSON.stringify([Number(!${extra}&&JSON.stringify(files)===JSON.stringify(['apps/api/dist/good.bin','apps/api/dist/reader.cjs']))]));}catch(e){console.log(JSON.stringify([Number(${extra}&&e instanceof Error&&e.message==='us_hosted_release_file_invalid')]));}finally{reader.dispose();}})().catch(()=>{process.exitCode=1});`;
  return JSON.parse(
    execFileSync(
      process.execPath,
      [resolve(__dirname, "support/us-hosted-installed-fixture.mjs")],
      {
        input: JSON.stringify({ moduleSource, setup, exercise }),
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ),
  );
}
beforeAll(() => {
  inventoryOutput = inventoryFixture(false);
});
beforeAll(() => {
  extraOutput = inventoryFixture(true);
});
it("enumerates the complete fixed artifact tree without treating the test tree as a release", () => {
  expect(inventoryOutput).toEqual({ result: [1], created: 1, removed: 1 });
});
it("rejects an unlisted file outside the fixed package roots", () => {
  expect(extraOutput).toEqual({ result: [1], created: 1, removed: 1 });
});

let captureCadence: unknown;
beforeAll(() => {
  const moduleSource = ts.transpileModule(
    readFileSync(resolve(__dirname, "../src/deployment/us-hosted-release-files.ts"), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } },
  ).outputText;
  const setup = `const fs=require('node:fs');fs.mkdirSync('/app/node_modules/.pnpm/fflate@0.8.3/node_modules/fflate',{recursive:true});for(const [name,text] of [['package.json',JSON.stringify({name:'fflate',version:'0.8.3',main:'index.cjs'})],['index.cjs','module.exports={}']])fs.writeFileSync('/app/node_modules/.pnpm/fflate@0.8.3/node_modules/fflate/'+name,text,{mode:0o444});fs.symlinkSync('.pnpm/fflate@0.8.3/node_modules/fflate','/app/node_modules/fflate');for(const name of ['a','b'])fs.writeFileSync('/app/apps/api/dist/'+name+'.cjs','',{mode:0o444});`;
  const exercise = `
    const statFs=require('node:fs');const {UsHostedReleaseFiles}=require('/app/apps/api/dist/reader.cjs');
    const native=statFs.lstatSync;const result=[];const invalid=e=>e instanceof Error&&e.message==='us_hosted_release_file_invalid';
    const altered=stat=>new Proxy(stat,{get(target,key){if(key==='mtimeNs')return target.mtimeNs+1n;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    (async()=>{
      const reader=new UsHostedReleaseFiles();let phase='initial',consumed='';
      try{
        await reader.capturePackage('apps/api/dist/a.cjs','fflate');
        statFs.lstatSync=function(path,...args){const stat=native.call(statFs,path,...args);if(path==='/app/apps/api/dist/a.cjs'){consumed=phase;return altered(stat);}return stat;};
        phase='second';let returned=false;try{await reader.capturePackage('apps/api/dist/b.cjs','fflate');returned=true;}catch(e){if(!invalid(e))throw e;}
        result.push(Number(returned),Number(!returned&&consumed==='second'));
        phase='full';consumed='';let denied=false;if(returned)try{await reader.assertUnchanged();}catch(e){denied=invalid(e);}
        result.push(Number(denied&&consumed==='full'));
      }finally{statFs.lstatSync=native;reader.dispose();}
      for(const kind of ['importer','metadata','entry','parent']){
        const local=new UsHostedReleaseFiles();let armed=false,consumed=false,entryReads=0,parentReads=0;
        const selected=kind==='parent'?'/app/apps/api/dist':kind==='importer'?'/app/apps/api/dist/b.cjs':kind==='metadata'?'/app/node_modules/.pnpm/fflate@0.8.3/node_modules/fflate/package.json':'/app/node_modules/.pnpm/fflate@0.8.3/node_modules/fflate/index.cjs';
        try{
          await local.capturePackage('apps/api/dist/b.cjs','fflate');
          statFs.lstatSync=function(path,...args){const stat=native.call(statFs,path,...args);if(path.endsWith('/fflate/index.cjs')&&++entryReads===2)armed=true;else if(armed&&path===selected){if(kind==='parent'&&++parentReads===1)return stat;consumed=true;return altered(stat);}return stat;};
          let denied=false;try{await local.capturePackage('apps/api/dist/b.cjs','fflate');}catch(e){denied=invalid(e);}
          result.push(Number(denied&&consumed));
        }finally{statFs.lstatSync=native;local.dispose();}
      }
      const inventory=new UsHostedReleaseFiles();let atInventoryFence=false,inventoryConsumed=false;
      try{
        await inventory.read('apps/api/dist/a.cjs',1024);
        const fullFence=inventory.assertUnchanged;
        inventory.assertUnchanged=async function(...args){atInventoryFence=true;return fullFence.apply(this,args);};
        statFs.lstatSync=function(path,...args){const stat=native.call(statFs,path,...args);if(atInventoryFence&&path==='/app/apps/api/dist/a.cjs'){inventoryConsumed=true;return altered(stat);}return stat;};
        let refused=false;try{await inventory.inventory();}catch(e){refused=invalid(e);}
        result.push(Number(refused),Number(inventoryConsumed));
      }finally{statFs.lstatSync=native;inventory.dispose();}
      console.log(JSON.stringify(result));
    })().catch(()=>{process.stderr.write('capture_cadence_fixture_failed');process.exitCode=1;});`;
  captureCadence = JSON.parse(
    execFileSync(
      process.execPath,
      [resolve(__dirname, "support/us-hosted-installed-fixture.mjs")],
      {
        input: JSON.stringify({ moduleSource, setup, exercise }),
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ),
  );
});
it("uses stat simulations for changed cadence and independent local file/parent fences", () => {
  expect(captureCadence).toEqual({ result: [1, 0, 1, 1, 1, 1, 1, 1, 1], created: 1, removed: 1 });
});

let missingCaptureRecords: unknown;
beforeAll(() => {
  const source = readFileSync(
    resolve(__dirname, "../src/deployment/us-hosted-release-files.ts"),
    "utf8",
  );
  const literal = "await this.#assertCapture(observed, new Set([importer, relative]));";
  expect(source.split(literal)).toHaveLength(2);
  const compile = (text: string) =>
    ts.transpileModule(text, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
    }).outputText;
  const candidates = ["importer", "relative"].map((key) =>
    compile(source.replace(literal, "this.#records.delete(" + key + ");" + literal)),
  );
  const setup = `const fs=require('node:fs');fs.mkdirSync('/app/node_modules/.pnpm/fflate@0.8.3/node_modules/fflate',{recursive:true});for(const [name,text] of [['package.json',JSON.stringify({name:'fflate',version:'0.8.3',main:'index.cjs'})],['index.cjs','module.exports={}']])fs.writeFileSync('/app/node_modules/.pnpm/fflate@0.8.3/node_modules/fflate/'+name,text,{mode:0o444});fs.symlinkSync('.pnpm/fflate@0.8.3/node_modules/fflate','/app/node_modules/fflate');fs.writeFileSync('/app/apps/api/dist/importer.cjs','',{mode:0o444});for(const [index,source] of ${JSON.stringify(candidates)}.entries())fs.writeFileSync('/app/apps/api/dist/missing-'+index+'.cjs',source,{mode:0o444});`;
  const exercise = `(async()=>{const result=[];for(const index of [0,1]){const {UsHostedReleaseFiles}=require('/app/apps/api/dist/missing-'+index+'.cjs');const reader=new UsHostedReleaseFiles();try{await reader.capturePackage('apps/api/dist/importer.cjs','fflate');result.push(0);}catch(e){result.push(Number(e instanceof Error&&e.message==='us_hosted_release_file_invalid'));}finally{reader.dispose();}}console.log(JSON.stringify(result));})().catch(()=>{process.stderr.write('missing_record_fixture_failed');process.exitCode=1;});`;
  missingCaptureRecords = JSON.parse(
    execFileSync(
      process.execPath,
      [resolve(__dirname, "support/us-hosted-installed-fixture.mjs")],
      {
        input: JSON.stringify({ moduleSource: compile(source), setup, exercise }),
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ),
  );
});
it("refuses either absent required capture snapshot instead of silently skipping it", () => {
  expect(missingCaptureRecords).toEqual({ result: [1, 1], created: 1, removed: 1 });
});

function restoreAsyncMetadata(source: string): string {
  if (!source.includes("lstatSync")) return source;
  expect(source.split("lstatSync(")).toHaveLength(19);
  expect(source.split("readlinkSync(")).toHaveLength(2);
  expect(source.split("return Promise.resolve(current);")).toHaveLength(2);
  expect(source.split("return Promise.resolve();")).toHaveLength(3);
  return source
    .replace(
      'import { constants, lstatSync, readlinkSync, type BigIntStats } from "node:fs";',
      'import { constants, type BigIntStats } from "node:fs";',
    )
    .replace(
      'import { open, opendir } from "node:fs/promises";',
      'import { lstat, open, opendir, readlink } from "node:fs/promises";',
    )
    .replaceAll("lstatSync(", "await lstat(")
    .replaceAll("readlinkSync(", "await readlink(")
    .replace("return Promise.resolve(current);", "return current;")
    .replaceAll("      return Promise.resolve();\n", "")
    .replaceAll("    return Promise.resolve();\n", "");
}
it("restores the complete asynchronous C9 reader by exact literal inverse", () => {
  const source = readFileSync(
    resolve(__dirname, "../src/deployment/us-hosted-release-files.ts"),
    "utf8",
  );
  expect(createHash("sha256").update(restoreAsyncMetadata(source)).digest("hex")).toBe(
    "55edc4efe2a15b6a265c8e11a709712cdcee8e75d6f09fd1ea37004930a27f78",
  );
});
let metadataTrace: unknown;
beforeAll(() => {
  const source = readFileSync(
    resolve(__dirname, "../src/deployment/us-hosted-release-files.ts"),
    "utf8",
  );
  const compile = (value: string) =>
    ts.transpileModule(value, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
    }).outputText;
  const reference = restoreAsyncMetadata(source);
  expect(createHash("sha256").update(reference).digest("hex")).toBe(
    "55edc4efe2a15b6a265c8e11a709712cdcee8e75d6f09fd1ea37004930a27f78",
  );
  const setup = `const fs=require('node:fs');fs.writeFileSync('/app/apps/api/dist/reference.cjs',${JSON.stringify(compile(reference))},{mode:0o444});fs.mkdirSync('/app/node_modules/.pnpm/fflate@0.8.3/node_modules/fflate',{recursive:true});for(const [name,text] of [['package.json',JSON.stringify({name:'fflate',version:'0.8.3',main:'index.cjs'})],['index.cjs','module.exports={}']])fs.writeFileSync('/app/node_modules/.pnpm/fflate@0.8.3/node_modules/fflate/'+name,text,{mode:0o444});fs.symlinkSync('.pnpm/fflate@0.8.3/node_modules/fflate','/app/node_modules/fflate');fs.mkdirSync('/app/node_modules/@react-pdf',{recursive:true});fs.symlinkSync('/etc','/app/node_modules/@react-pdf/renderer');for(const name of ['a','b','disposable'])fs.writeFileSync('/app/apps/api/dist/'+name+'.cjs','',{mode:0o444});`;
  const exercise = `
    const fs=require('node:fs'),fsp=require('node:fs/promises');
    const classes=[require('/app/apps/api/dist/reference.cjs').UsHostedReleaseFiles,require('/app/apps/api/dist/reader.cjs').UsHostedReleaseFiles];
    const original={lstat:fsp.lstat,readlink:fsp.readlink,lstatSync:fs.lstatSync,readlinkSync:fs.readlinkSync};
    const traces=[],asynchronous=[],flags=[];
    const code=e=>e&&typeof e==='object'&&typeof e.code==='string'?e.code:'fixed';
    (async()=>{
      for(const Reader of classes){
        const trace=[];let dispatches=0;const reader=new Reader();
        for(const name of ['lstat','readlink']){
          fsp[name]=async function(...args){dispatches++;const row=[name,args,'pending'];trace.push(row);try{const value=await original[name].apply(fsp,args);row[2]='ok';return value;}catch(e){row[2]=code(e);throw e;}};
          fs[name+'Sync']=function(...args){const row=[name,args,'pending'];trace.push(row);try{const value=original[name+'Sync'].apply(fs,args);row[2]='ok';return value;}catch(e){row[2]=code(e);throw e;}};
        }
        try{
          const first=await reader.capturePackage('apps/api/dist/a.cjs','fflate');
          const again=await reader.capturePackage('apps/api/dist/a.cjs','fflate');
          await reader.capturePackage('apps/api/dist/b.cjs','fflate');
          await reader.inventory();await reader.assertUnchanged();
          const denied=new Reader();let rejected=false;try{await denied.capturePackage('apps/api/dist/a.cjs','@react-pdf/renderer');}catch(e){rejected=e instanceof Error&&e.message==='us_hosted_release_file_invalid';}finally{denied.dispose();}
          const cancel=new Reader();const beforeFd=fs.readdirSync('/proc/self/fd').length;const reading=cancel.read('apps/api/dist/disposable.cjs',1024);cancel.dispose();let disposedRefusal=false;try{await reading;}catch(e){disposedRefusal=e instanceof Error&&e.message==='us_hosted_release_file_invalid';}const handlesClosed=fs.readdirSync('/proc/self/fd').length===beforeFd;reader.dispose();let synchronousThrow=false,pending;try{pending=reader.assertUnchanged();}catch{synchronousThrow=true;}let rejectedPromise=false;try{await pending;}catch(e){rejectedPromise=e instanceof Error&&e.message==='us_hosted_release_file_invalid';}
          flags.push(Number(first.owner===again.owner&&first.entry===again.entry&&first.metadata===again.metadata&&rejected&&!synchronousThrow&&pending instanceof Promise&&rejectedPromise&&disposedRefusal&&handlesClosed));
        }finally{fsp.lstat=original.lstat;fsp.readlink=original.readlink;fs.lstatSync=original.lstatSync;fs.readlinkSync=original.readlinkSync;reader.dispose();}
        traces.push(trace);asynchronous.push(dispatches);
      }
      console.log(JSON.stringify([Number(JSON.stringify(traces[0])===JSON.stringify(traces[1])),Number(asynchronous[0]>0&&asynchronous[1]===0),Number(traces[0].some(row=>row[2]==='ENOENT')),Number(traces[0].some(row=>row[0]==='readlink')), ...flags]));
    })().catch(()=>{process.stderr.write('metadata_trace_fixture_failed');process.exitCode=1;});`;
  metadataTrace = JSON.parse(
    execFileSync(
      process.execPath,
      [resolve(__dirname, "support/us-hosted-installed-fixture.mjs")],
      {
        input: JSON.stringify({ moduleSource: compile(source), setup, exercise }),
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ),
  );
});
it("preserves ordered native metadata observations and rejected promises without async metadata dispatch", () => {
  expect(metadataTrace).toEqual({ result: [1, 1, 1, 1, 1, 1], created: 1, removed: 1 });
});
