import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const profileNames = [
  "migrate",
  "seed",
  "provision",
  "wrongCA",
  "wrongName",
  "plaintext",
  "wrongDatabase",
  "wrongUser",
  "badMode",
  "badCA",
  "oversizedSecret",
  "symlinkSecret",
] as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const owner = z.string().regex(/^us-admin-preflight-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const entry = z
  .object({ containerId: digest, owner, network: z.string().min(1).max(100) })
  .strict();
const receiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("synthetic-test-only"),
    baseSha: z.string().regex(/^[a-f0-9]{40}$/),
    patchSha256: digest,
    fixtureSha: z.string().regex(/^[a-f0-9]{40}$/),
    manifestSha256: digest,
    adminManifestSha256: digest,
    fixtures: z
      .object({
        migrate: entry,
        seed: entry,
        provision: entry,
        wrongCA: entry,
        wrongName: entry,
        plaintext: entry,
        wrongDatabase: entry,
        wrongUser: entry,
        badMode: entry,
        badCA: entry,
        oversizedSecret: entry,
        symlinkSecret: entry,
      })
      .strict(),
  })
  .strict()
  .refine(
    (value) =>
      new Set(Object.values(value.fixtures).map((v) => v.containerId)).size === 12 &&
      new Set(Object.values(value.fixtures).map((v) => v.owner)).size === 12,
  );
const receiptPath = resolve(
  __dirname,
  "../../../.superpowers/sdd/2026-10-22-us-11-demo-viewer/installed-fixtures/admin-preflight-current.json",
);
const invalid = () => new Error("us_hosted_admin_native_exercise_failed");
const active = new Set<Promise<string>>();
type NativePhase = Readonly<{ phase: string; elapsedMs: number }>;
let parsePhase: ((line: string) => NativePhase | undefined) | undefined;
function client(args: string[], input?: string, diagnostic = false): Promise<string> {
  const result = new Promise<string>((resolve, reject) => {
    const started = performance.now();
    let frames = 0,
      firstGuest = false,
      buffered = "";
    const emit = (phase: string, elapsedMs: number) => {
      if (!diagnostic || frames >= 32) return;
      const value = parsePhase?.("US_ADMIN_PHASE " + JSON.stringify({ phase, elapsedMs }));
      if (value) {
        frames++;
        process.stderr.write("US_ADMIN_PHASE " + JSON.stringify(value) + "\n");
      }
    };
    emit("host_dispatch", 0);
    const child = execFile(
      "docker",
      args,
      { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, killSignal: "SIGTERM" },
      (error, stdout) => {
        emit(error ? "host_completed_error" : "host_completed_ok", performance.now() - started);
        if (error) reject(invalid());
        else resolve(stdout);
      },
    );
    if (diagnostic)
      child.stderr?.on("data", (chunk: Buffer | string) => {
        buffered += chunk.toString();
        let end;
        while ((end = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          const value = parsePhase?.(line);
          if (value) {
            if (!firstGuest) {
              firstGuest = true;
              emit("host_first_guest_marker", performance.now() - started);
            }
            emit(value.phase, value.elapsedMs);
          }
        }
        if (buffered.length > 4096) buffered = "";
      });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
  active.add(result);
  void result.then(
    () => active.delete(result),
    () => active.delete(result),
  );
  return result;
}
it("requires distinct actual administrative preflight installations", () => {
  expect(receiptSchema.safeParse({}).success).toBe(false);
  expect(profileNames).toHaveLength(12);
});

describe.skipIf(!existsSync(receiptPath))(
  "genuine installed administrative material and PostgreSQL TLS",
  () => {
    let receipt: z.infer<typeof receiptSchema>;
    beforeAll(async () => {
      expect(statSync(receiptPath).size).toBeLessThanOrEqual(16384);
      receipt = receiptSchema.parse(JSON.parse(readFileSync(receiptPath, "utf8")));
      const holders = (
        await client([
          "inspect",
          "--format",
          '[{{json .Id}},{{json (index .Config.Labels "us-fixture-owner")}},{{json .Config.User}},{{json .HostConfig.ReadonlyRootfs}},{{json .HostConfig.NetworkMode}},{{json .NetworkSettings.Networks}}]',
          ...profileNames.map((name) => receipt.fixtures[name].containerId),
        ])
      )
        .trim()
        .split("\n")
        .map((line) =>
          z
            .tuple([
              digest,
              owner,
              z.literal("10001:10001"),
              z.literal(true),
              z.string(),
              z.record(z.string(), z.unknown()),
            ])
            .parse(JSON.parse(line)),
        );
      const networks = (
        await client([
          "network",
          "inspect",
          "--format",
          '[{{json .Id}},{{json .Name}},{{json .Internal}},{{json (index .Labels "us-fixture-owner")}}]',
          ...profileNames.slice(0, 8).map((name) => receipt.fixtures[name].network),
        ])
      )
        .trim()
        .split("\n")
        .map((line) =>
          z.tuple([digest, z.string(), z.literal(true), owner]).parse(JSON.parse(line)),
        );
      expect(holders).toHaveLength(12);
      expect(new Set(holders.map((row) => row[0])).size).toBe(12);
      expect(networks).toHaveLength(8);
      expect(new Set(networks.map((row) => row[1])).size).toBe(8);
      const helperPath = resolve(__dirname, "support/us-hosted-admin-preflight-fixture.mjs");
      const helper = await import(helperPath);
      parsePhase = helper.parseAdministrativeNativePhase;
      for (const name of profileNames) {
        const value = receipt.fixtures[name];
        const holder = holders.find((row) => row[0] === value.containerId);
        expect(holder).toBeDefined();
        if (!holder) throw invalid();
        expect(holder[1]).toBe(value.owner);
        if (profileNames.indexOf(name) < 8) {
          expect(value.network).toBe(value.owner + "-network");
          const network = networks.find((row) => row[1] === value.network);
          expect(network).toBeDefined();
          if (!network) throw invalid();
          expect(network[3]).toBe(value.owner);
          helper.assertAdministrativeHolderNetwork(JSON.stringify(holder[5]), {
            owner: value.owner,
            name: value.network,
            id: network[0],
          });
        } else {
          expect(value.network).toBe("none");
          expect(holder[4]).toBe("none");
        }
      }
    });
    afterAll(async () => {
      await Promise.allSettled([...active]);
      if (!receipt) return;
      for (const name of profileNames) {
        const processProgram = `
const fs = require('node:fs');
const rows = fs.readdirSync('/proc').filter(name => /^[1-9][0-9]*$/.test(name) && Number(name) !== process.pid)
  .map(name => [name, fs.readFileSync('/proc/' + name + '/comm', 'utf8').trim()]);
process.stdout.write('PID COMMAND\\n' + rows.map(row => row.join(' ')).join('\\n') + '\\n');
`;
        const rows = (
          await client([
            "exec",
            "--user",
            "10001:10001",
            receipt.fixtures[name].containerId,
            "node",
            "-e",
            processProgram,
          ])
        )
          .trim()
          .split("\n")
          .slice(1)
          .map((s) => s.trim().split(/\s+/));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toHaveLength(2);
        expect(rows[0]?.[0]).toBe("1");
        expect(["MainThread", "node"]).toContain(rows[0]?.[1]);
      }
    });
    async function exercise(name: (typeof profileNames)[number], body: string): Promise<number[]> {
      const operation = name === "seed" || name === "provision" ? name : "migrate";
      const program = `process.stdout.write(JSON.stringify({pid:process.pid})+String.fromCharCode(10));
      const phaseStarted=performance.now();
      const phase=name=>{if(${JSON.stringify(name === "wrongName")})process.stderr.write('US_ADMIN_PHASE '+JSON.stringify({phase:name,elapsedMs:performance.now()-phaseStarted})+String.fromCharCode(10));};
      phase('guest_started');
      const assert=require('node:assert/strict');
      const release=require('/app/apps/api/dist/deployment/us-hosted-admin-release.js');
      const material=require('/app/apps/api/dist/deployment/us-hosted-admin-material-owner.js');
      const database=require('/app/apps/api/dist/deployment/us-hosted-admin-database.js');
      const operation=${JSON.stringify(operation)};
      phase('modules_loaded');
      (async()=>{${body}})().catch(()=>{process.stderr.write('us_hosted_admin_native_child_failed');process.exitCode=1;});`;
      const text = await client(
        ["exec", "-i", "--user", "10001:10001", receipt.fixtures[name].containerId, "node"],
        program,
        name === "wrongName",
      );
      const lines = text.trimEnd().split("\n");
      expect(lines).toHaveLength(2);
      z.object({ pid: z.number().int().min(2).safe() })
        .strict()
        .parse(JSON.parse(lines[0] ?? ""));
      return z
        .array(z.union([z.literal(0), z.literal(1)]))
        .max(16)
        .parse(JSON.parse(lines[1] ?? ""));
    }

    it.each(["migrate", "seed", "provision"] as const)(
      "owns genuine %s material and a checked native TLS client",
      async (name) => {
        expect(
          await exercise(
            name,
            `
      const {createRequire}=require('node:module');
      const dbEntry=createRequire('/app/apps/api/dist/deployment/us-hosted-admin-database.js').resolve('@markiro/db');
      assert.equal(Number(Boolean(require.cache[dbEntry])),0);
      const pg=createRequire(dbEntry)('pg'),descriptor=Object.getOwnPropertyDescriptor(pg,'Pool'),NativePool=pg.Pool;
      let poolConstructions=0;
      Object.defineProperty(pg,'Pool',{configurable:true,value:class extends NativePool{constructor(options){poolConstructions++;super(options);}}});
      const r=await release.verifyUsHostedAdminRelease(operation);let m,d;
      try{m=await material.collectUsHostedAdminMaterial(r);
        assert.equal(release.usHostedAdminReleaseIdentity(r).sourceSha,${JSON.stringify(receipt.fixtureSha)});
        assert.equal(release.usHostedAdminReleaseIdentity(r).manifestSha256,${JSON.stringify(receipt.manifestSha256)});
        assert.equal(release.usHostedAdminReleaseIdentity(r).adminManifestSha256,${JSON.stringify(receipt.adminManifestSha256)});
        assert.throws(()=>material.assertUsHostedAdminMaterial(Object.freeze({...m}),r));
        const values=material.usHostedAdminDatabaseMaterial(m,r);assert.equal(Object.keys(values).length,0);
        if(operation==='seed')material.usHostedAdminSeedStorageMaterial(m,r);else assert.throws(()=>material.usHostedAdminSeedStorageMaterial(m,r));
        d=await database.createUsHostedAdminDatabase(r,m);
        assert.equal(poolConstructions,1);assert.equal(Number(Boolean(require.cache[dbEntry])),0);
        assert.deepEqual(database.usHostedAdminDatabaseIdentity(d,r,m),{operation,database:'markiro_us_synthetic',user:'markiro_us'});
        assert.throws(()=>database.assertUsHostedAdminDatabase(Object.freeze({...d}),r,m));
        const first=database.closeUsHostedAdminDatabase(d);assert.equal(first,database.closeUsHostedAdminDatabase(d));await first;
        assert.throws(()=>database.assertUsHostedAdminDatabase(d,r,m));
        material.disposeUsHostedAdminMaterial(m);assert.throws(()=>material.assertUsHostedAdminMaterial(m,r));
        console.log(JSON.stringify([1,1,1,1,1,1]));
      }finally{if(d)await database.closeUsHostedAdminDatabase(d);if(m)material.disposeUsHostedAdminMaterial(m);release.disposeUsHostedAdminRelease(r);Object.defineProperty(pg,'Pool',descriptor);}`,
          ),
        ).toEqual([1, 1, 1, 1, 1, 1]);
      },
    );

    it.each(["badMode", "badCA", "oversizedSecret", "symlinkSecret"] as const)(
      "refuses independently installed %s material",
      async (name) => {
        expect(
          await exercise(
            name,
            `
      const r=await release.verifyUsHostedAdminRelease(operation);let m,refused=false;
      try{try{m=await material.collectUsHostedAdminMaterial(r);}catch(e){refused=e instanceof Error&&e.message==='us_hosted_admin_material_invalid';}
        console.log(JSON.stringify([Number(refused),Number(!m)]));
      }finally{if(m)material.disposeUsHostedAdminMaterial(m);release.disposeUsHostedAdminRelease(r);}`,
          ),
        ).toEqual([1, 1]);
      },
    );

    it.each(["wrongCA", "wrongName", "plaintext", "wrongDatabase", "wrongUser"] as const)(
      "refuses the actual %s database peer",
      async (name) => {
        const caMutant = name === "wrongCA" && process.env.US_HOSTED_TEST_ADMIN_CA_MUTANT === "1";
        const nameMutant =
          name === "wrongName" && process.env.US_HOSTED_TEST_ADMIN_NAME_MUTANT === "1";
        expect(
          await exercise(
            name,
            `
      const tls=require('node:tls'),{createRequire}=require('node:module');const pg=createRequire('/app/packages/db/package.json')('pg');
      const descriptor=Object.getOwnPropertyDescriptor(pg,'Pool'),NativePool=pg.Pool,originalConnect=tls.connect;
      let ends=0,released=0,mutated=0,refused=false,d,r,m;
      Object.defineProperty(pg,'Pool',{configurable:true,value:class extends NativePool{
        constructor(options){if(${JSON.stringify(caMutant)}){options={...options,ssl:{...options.ssl,rejectUnauthorized:false}};mutated++;}super(options);}
        async connect(...args){const c=await super.connect(...args),original=c.release;c.release=function(...args){released++;return original.apply(this,args);};return c;}
        async end(...args){ends++;phase('pool_end_begin');try{return await super.end(...args);}finally{phase('pool_end_end');}}
      }});
      if(${JSON.stringify(nameMutant)})tls.connect=function(options,...args){return originalConnect.call(this,{...options,checkServerIdentity(){mutated++;return undefined;}},...args);};
      try{phase('release_begin');r=await release.verifyUsHostedAdminRelease(operation);phase('release_end');phase('material_begin');m=await material.collectUsHostedAdminMaterial(r);phase('material_end');
        phase('connection_begin');try{d=await database.createUsHostedAdminDatabase(r,m);}catch(e){refused=e instanceof Error&&e.message==='us_hosted_admin_database_invalid';}phase('connection_settled');
        if(d)await database.closeUsHostedAdminDatabase(d);
        if(${JSON.stringify(caMutant || nameMutant)})assert.equal(mutated,1);
        console.log(JSON.stringify([Number(refused),Number(!d),Number(ends===1&&released===Number(Boolean(d)))]));
      }finally{if(d)await database.closeUsHostedAdminDatabase(d);if(m)material.disposeUsHostedAdminMaterial(m);if(r)release.disposeUsHostedAdminRelease(r);
        Object.defineProperty(pg,'Pool',descriptor);tls.connect=originalConnect;phase('disposal_complete');}`,
          ),
        ).toEqual([1, 1, 1]);
      },
    );

    it.each(["connect", "query"] as const)(
      "settles actual %s work before refusing disposed authority",
      async (phase) => {
        expect(
          await exercise(
            "migrate",
            `
      const {createRequire}=require('node:module'),pg=createRequire('/app/packages/db/package.json')('pg');
      const descriptor=Object.getOwnPropertyDescriptor(pg,'Pool'),NativePool=pg.Pool;let r,m,d,ends=0,released=0,consumed=false,refused=false;
      Object.defineProperty(pg,'Pool',{configurable:true,value:class extends NativePool{
        async connect(...args){const c=await super.connect(...args),originalRelease=c.release,originalQuery=c.query;
          c.release=function(...args){released++;return originalRelease.apply(this,args);};
          if(${JSON.stringify(phase)}==='connect'){consumed=true;await new Promise(resolve=>queueMicrotask(()=>{material.disposeUsHostedAdminMaterial(m);resolve();}));}
          else c.query=async function(...args){const result=await originalQuery.apply(this,args);consumed=true;await new Promise(resolve=>queueMicrotask(()=>{release.disposeUsHostedAdminRelease(r);resolve();}));return result;};
          return c;}
        async end(...args){ends++;return super.end(...args);}
      }});
      try{r=await release.verifyUsHostedAdminRelease(operation);m=await material.collectUsHostedAdminMaterial(r);
        try{d=await database.createUsHostedAdminDatabase(r,m);}catch(e){refused=e instanceof Error&&e.message==='us_hosted_admin_database_invalid';}
        if(d)await database.closeUsHostedAdminDatabase(d);
        console.log(JSON.stringify([Number(consumed),Number(refused),Number(!d),Number(ends===1&&released===1)]));
      }finally{if(d)await database.closeUsHostedAdminDatabase(d);if(m)material.disposeUsHostedAdminMaterial(m);if(r)release.disposeUsHostedAdminRelease(r);Object.defineProperty(pg,'Pool',descriptor);}`,
          ),
        ).toEqual([1, 1, 1, 1]);
      },
    );

    it.each(["PGOPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED"])(
      "refuses actual inherited %s before acquiring a native pool",
      async (name) => {
        expect(
          await exercise(
            "migrate",
            `
      const {createRequire}=require('node:module'),pg=createRequire('/app/packages/db/package.json')('pg');
      const descriptor=Object.getOwnPropertyDescriptor(pg,'Pool'),NativePool=pg.Pool;let constructed=0,refused=false,d;
      const r=await release.verifyUsHostedAdminRelease(operation),m=await material.collectUsHostedAdminMaterial(r);
      Object.defineProperty(pg,'Pool',{configurable:true,value:class extends NativePool{constructor(options){constructed++;super(options);}}});
      const name=${JSON.stringify(name)},previous=process.env[name];process.env[name]='synthetic-native-blocked-option';
      try{try{d=await database.createUsHostedAdminDatabase(r,m);}catch(e){refused=e instanceof Error&&e.message==='us_hosted_admin_database_invalid';}
        if(d)await database.closeUsHostedAdminDatabase(d);console.log(JSON.stringify([Number(refused),Number(constructed===0)]));
      }finally{if(previous===undefined)delete process.env[name];else process.env[name]=previous;if(d)await database.closeUsHostedAdminDatabase(d);
        material.disposeUsHostedAdminMaterial(m);release.disposeUsHostedAdminRelease(r);Object.defineProperty(pg,'Pool',descriptor);}`,
          ),
        ).toEqual([1, 1]);
      },
    );
    it.each(["/run/secrets/us-demo/admin-migrate-db-password", "/run/secrets/us-demo"])(
      "consumes native stat replacement of %s before material issuance",
      async (path) => {
        expect(
          await exercise(
            "migrate",
            `
      const fs=require('node:fs/promises'),readerModule=require('/app/apps/api/dist/deployment/us-hosted-admin-file-reader.js');
      const originalStat=fs.lstat,originalCreate=readerModule.createUsHostedAdminFileReader;let armed=false,consumed=false,refused=false,m;
      readerModule.createUsHostedAdminFileReader=function(...args){const reader=originalCreate.apply(this,args);return {...reader,async assertUnchanged(){armed=true;return reader.assertUnchanged();}};};
      fs.lstat=async function(file,...args){const value=await originalStat.call(this,file,...args);if(armed&&file===${JSON.stringify(path)}){consumed=true;return new Proxy(value,{get(target,key){if(key==='mtimeNs')return target.mtimeNs+1n;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});}return value;};
      const r=await release.verifyUsHostedAdminRelease(operation);
      try{try{m=await material.collectUsHostedAdminMaterial(r);}catch(e){refused=e instanceof Error&&e.message==='us_hosted_admin_material_invalid';}
        console.log(JSON.stringify([Number(consumed),Number(refused),Number(!m)]));
      }finally{if(m)material.disposeUsHostedAdminMaterial(m);release.disposeUsHostedAdminRelease(r);fs.lstat=originalStat;readerModule.createUsHostedAdminFileReader=originalCreate;}`,
          ),
        ).toEqual([1, 1, 1]);
      },
    );
  },
);
