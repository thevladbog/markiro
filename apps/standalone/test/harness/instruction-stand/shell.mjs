// The Tauri shell of apps/standalone (src-tauri) in Node, for the instruction stand: the webview
// runs in Chromium and every `invoke` lands here (see tauri-init.js). Host calls go to a real
// markiro-host over HTTPS with the certificate pinned the way the shell pins it; the local
// database is node:sqlite over the shell's own migrations; hardware, files and updates get
// canned answers shaped like the Rust structs. Not a product path: the stand only.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import https from "node:https";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS = new URL("../../../src-tauri/migrations/", import.meta.url);
const APP_VERSION = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
).version;
const PROTOCOL_VERSION = 7;
export const STATUS_EVENT = "standalone://host-status";
export const REVISION_EVENT = "standalone://host-revision";

/**
 * TLS options that trust only this host's own certificate (`<data dir>/tls/cert.der`, which
 * `connect.certFile` names) and pin it by SHA-256, as the shell does; the names inside the
 * certificate do not matter. Throws while the host has not written its certificate yet.
 */
function pinnedTls(connect) {
  const der = readFileSync(connect.certFile);
  const base64 = der.toString("base64").replace(/.{1,64}/g, "$&\n");
  const expected = createHash("sha256").update(der).digest("hex");
  return {
    ca: `-----BEGIN CERTIFICATE-----\n${base64}-----END CERTIFICATE-----\n`,
    checkServerIdentity: (_name, certificate) =>
      createHash("sha256").update(certificate.raw).digest("hex") === expected
        ? undefined
        : new Error("certificate_mismatch"),
  };
}

/** One HTTPS call to the host, which must present the certificate in `connect.certFile`. */
export function hostCall(connect, { method, path, body, headers = {}, timeoutMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? undefined : JSON.stringify(body);
    const request = https.request(
      {
        host: connect.host,
        port: connect.port,
        method,
        path,
        ...pinnedTls(connect),
        agent: false,
        timeout: timeoutMs,
        headers: {
          "x-markiro-protocol": String(PROTOCOL_VERSION),
          "x-markiro-app-version": APP_VERSION,
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
      },
      (response) => {
        const fingerprint = createHash("sha256")
          .update(response.socket.getPeerCertificate().raw)
          .digest("hex");
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          if (text.length > 0) {
            try {
              parsed = JSON.parse(text);
            } catch {
              reject("invalid_response");
              return;
            }
          }
          resolve({ status: response.statusCode, body: parsed, fingerprint });
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", (error) => reject(error.message === "timeout" ? "timeout" : "unreachable"));
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

/** The station's local database: the shell's migrations on node:sqlite (`test/support/local-db.ts`). */
function openLocalDb(path) {
  const db = new DatabaseSync(path);
  const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get();
  if (tables.n === 0) {
    for (const name of readdirSync(MIGRATIONS)
      .filter((file) => file.endsWith(".sql"))
      .sort()) {
      db.exec(readFileSync(new URL(name, MIGRATIONS), "utf8"));
    }
  }
  return db;
}

function toSqlValue(value) {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isInteger(value) ? BigInt(value) : value;
  throw "unsupported_value";
}

function fromRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] =
      typeof value === "bigint" ? Number(value) : value instanceof Uint8Array ? [...value] : value;
  }
  return out;
}

/**
 * The shell of one computer. `role` is the installer's role (`host`, `station`, `office`);
 * `connect` where the host really is; `displayAddress` the address the screens show
 * (a LAN address, as on a site); `state` the device record kept between runs (`device.json`).
 */
export class StandShell {
  constructor({
    role,
    connect,
    displayAddress,
    localDbPath,
    state,
    emit,
    now = Date.now,
    log = () => {},
  }) {
    this.role = role;
    this.connect = connect;
    this.displayAddress = displayAddress;
    this.db = openLocalDb(localDbPath);
    this.device = state ?? null;
    this.emit = emit;
    this.now = now;
    this.log = log;
    this.seq = 0;
    this.lastContactAt = null;
    this.stream = null;
    this.printed = [];
    /** Canned hardware failures a state turns on (see `print_bytes`). */
    this.faults = {};
  }

  status() {
    if (this.device === null) return null;
    const { hostAddress, fingerprint, hostId, deviceId, kind, lineId, deviceName } = this.device;
    return { hostAddress, fingerprint, hostId, deviceId, kind, lineId, deviceName };
  }

  linkStatus() {
    const paired = this.device !== null;
    return {
      state: paired && this.stream !== null ? "online" : "offline",
      lastContactAt: paired ? this.lastContactAt : null,
      lastError: null,
      seq: this.seq,
    };
  }

  publishStatus() {
    this.seq += 1;
    this.emit(STATUS_EVENT, this.linkStatus());
  }

  async request(method, path, body, officeToken, timeoutMs) {
    if (this.device === null) throw "not_paired";
    const headers = { authorization: `Bearer ${this.device.key}` };
    if (officeToken) headers["x-office-session"] = officeToken;
    const answer = await hostCall(this.connect, { method, path, body, headers, timeoutMs });
    if (answer.fingerprint !== this.device.fingerprint) throw "certificate_mismatch";
    return { status: answer.status, body: answer.body };
  }

  async pair(path, body, kind, name) {
    const hello = await hostCall(this.connect, { method: "GET", path: "/v1/hello" });
    const answer = await hostCall(this.connect, { method: "POST", path, body });
    if (answer.status !== 200) throw answer.body?.error?.code ?? "pair_rejected";
    if (answer.body.hostId !== hello.body.hostId) throw "host_changed";
    this.device = {
      hostAddress: this.displayAddress,
      fingerprint: answer.fingerprint,
      hostId: answer.body.hostId,
      deviceId: answer.body.deviceId,
      kind,
      lineId: null,
      deviceName: name.trim(),
      key: answer.body.deviceKey,
    };
    this.openStream();
    return this.status();
  }

  keepRecord(answer) {
    if (answer.status === 401) throw "key_rejected";
    if (answer.status !== 200) throw "request_failed";
    this.device = {
      ...this.device,
      lineId: answer.body.lineId ?? null,
      deviceName: answer.body.name,
    };
    return this.status();
  }

  /** The change stream (`/v1/changes/stream`): its `rev` events become the shell's revision events. */
  openStream() {
    if (this.stream !== null || this.device === null) return;
    const request = https.request({
      host: this.connect.host,
      port: this.connect.port,
      path: "/v1/changes/stream",
      method: "GET",
      ...pinnedTls(this.connect),
      agent: false,
      headers: {
        authorization: `Bearer ${this.device.key}`,
        "x-markiro-protocol": String(PROTOCOL_VERSION),
        "x-markiro-app-version": APP_VERSION,
        accept: "text/event-stream",
      },
    });
    this.stream = request;
    request.on("response", (response) => {
      this.lastContactAt = this.now();
      this.publishStatus();
      let buffer = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        this.lastContactAt = this.now();
        buffer += chunk.replaceAll("\r\n", "\n");
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const lines = block.split("\n");
          if (!lines.includes("event: rev")) continue;
          const data = lines.find((line) => line.startsWith("data:"));
          if (data) this.emit(REVISION_EVENT, JSON.parse(data.slice(5)));
        }
      });
    });
    // A host that stops ends the stream: the shell's link goes offline, as `connection.rs` reports it.
    const lost = () => {
      if (this.stream !== request) return;
      this.stream = null;
      this.publishStatus();
    };
    request.on("error", lost);
    request.on("close", lost);
    request.end();
  }

  close() {
    this.stream?.destroy();
    this.stream = null;
    this.db.close();
  }

  /** One `invoke`: resolves with the command's answer or rejects with its error code. */
  async handle(command, args) {
    switch (command) {
      case "install_role":
        return this.role;
      case "plugin:app|version":
        return APP_VERSION;
      case "device_status":
        return this.status();
      case "device_repair_pending":
        return false;
      case "connection_status":
        this.openStream();
        return this.linkStatus();
      case "host_hello": {
        // A station on its own PC (`shell.faults.noLocalHost`): no host on this computer, so
        // the app offers to pair over the network; any other address reaches the stand's host.
        if (this.faults.noLocalHost && /127\.0\.0\.1|localhost/.test(String(args.address))) {
          throw "unreachable";
        }
        const answer = await hostCall(this.connect, { method: "GET", path: "/v1/hello" });
        return { hello: answer.body, fingerprint: answer.fingerprint };
      }
      case "host_local_pair":
        if (this.role === "office") throw "invalid_request";
        return this.pair(
          "/v1/local-pair",
          { kind: "station", name: args.name, appVersion: APP_VERSION, capabilities: [] },
          "station",
          args.name,
        );
      case "host_claim": {
        const code = String(args.code).toUpperCase().replace(/[\s-]/g, "");
        return this.pair(
          "/v1/pairing/claim",
          {
            code,
            kind: this.role === "office" ? "office" : "station",
            name: args.name,
            appVersion: APP_VERSION,
            capabilities: [],
          },
          this.role === "office" ? "office" : "station",
          args.name,
        );
      }
      case "host_request":
        return this.request(
          args.method,
          args.path,
          args.body ?? null,
          args.officeToken,
          args.timeoutMs,
        );
      case "device_select_line":
        return this.keepRecord(
          await this.request("PUT", "/v1/device/line", { lineId: args.lineId }),
        );
      case "device_refresh":
        return this.keepRecord(await this.request("GET", "/v1/device"));
      case "device_change_address":
        this.device = { ...this.device, hostAddress: args.address };
        return this.status();
      case "device_forget":
        this.stream?.destroy();
        this.stream = null;
        this.device = null;
        return null;
      case "local_query": {
        try {
          return this.db
            .prepare(args.sql)
            .all(...args.params.map(toSqlValue))
            .map(fromRow);
        } catch (error) {
          this.log(`local_query failed: ${String(error)} :: ${args.sql}`);
          throw "statement_failed";
        }
      }
      case "local_transaction": {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          const changes = args.statements.map(({ sql, values = [], expectedChanges }) => {
            const changed = Number(this.db.prepare(sql).run(...values.map(toSqlValue)).changes);
            if (
              expectedChanges !== undefined &&
              expectedChanges !== null &&
              changed !== expectedChanges
            ) {
              throw "changes_mismatch";
            }
            return changed;
          });
          this.db.exec("COMMIT");
          return changes;
        } catch (error) {
          this.db.exec("ROLLBACK");
          if (error === "changes_mismatch") throw error;
          this.log(`local_transaction failed: ${String(error)}`);
          throw "statement_failed";
        }
      }
      // Hardware: no scanner port, no installed queue, printing succeeds and is kept.
      case "list_serial_ports":
      case "list_usb_printers":
        return [];
      case "get_scanner_connections":
        return { revision: 0, scanners: [] };
      case "configure_scanners":
      case "close_scanners":
        return null;
      case "supports_windows_printing":
        return false;
      case "print_bytes":
        // A state may make the printer fail the way `PrintError::code` names it
        // (`not_sent`, `outcome_unknown`): `shell.faults.print = "not_sent"`.
        if (this.faults.print) throw this.faults.print;
        this.printed.push(args);
        return null;
      // The window and the power: a development build's answers.
      case "kiosk_permitted_now":
        return false;
      case "enter_lockdown":
      case "exit_lockdown":
      case "set_system_awake":
        return null;
      // Office files.
      // The folder is `APP_FOLDER` («Markiro») under the documents (src-tauri/src/office_files.rs).
      case "get_exports_folder":
        return { path: null, default: "C:\\Users\\Office\\Documents\\Markiro\\Выгрузки" };
      case "set_exports_folder":
        return {
          path: args.path ?? null,
          default: "C:\\Users\\Office\\Documents\\Markiro\\Выгрузки",
        };
      // Saved as `SavedFolder` says, nothing written: the office reports the folder and names.
      case "save_office_files":
        return {
          segments: args.segments,
          path: ["C:\\Users\\Office\\Documents\\Markiro", ...args.segments].join("\\"),
          files: args.files.map((file) => file.name),
        };
      case "open_office_folder":
      case "open_office_file":
      case "open_external_link":
      case "pick_folder":
        return null;
      // Updates: nothing staged, nothing found.
      case "update_outcome":
        return null;
      case "update_scan":
        return [];
      case "update_outcome_dismiss":
        return null;
      case "yandex_recovery_available":
        return false;
      default:
        this.log(`unhandled command ${command} ${JSON.stringify(args)}`);
        throw "invalid_request";
    }
  }
}
