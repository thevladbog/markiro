import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";

import { createTauriDeviceApi, type InstallRole } from "../../host/device.js";
import { createTauriHostProbe, type HelloObservation } from "../../host/probe.js";
import type { DeviceStatus } from "../../host/protocol.js";

/** The computer the app runs on, as the webview can tell without a command of the shell. */
export interface SystemInfo {
  /** «Windows 11», «Windows 10», or the platform's own name. */
  os: string;
  /** «x64», «arm64» …, when the webview says. */
  arch: string | null;
  /** The webview's own version («WebView2 130.0.2849.80»), when it says. */
  webview: string | null;
}

/** The codes `open_external_link` refuses with (`ExternalLinkError::code`). */
export const EXTERNAL_LINK_CODES = ["invalid_request", "unsupported", "launch"] as const;
export type ExternalLinkCode = (typeof EXTERNAL_LINK_CODES)[number];

export class ExternalLinkError extends Error {
  readonly code: ExternalLinkCode;

  constructor(code: ExternalLinkCode, message: string) {
    super(message);
    this.name = "ExternalLinkError";
    this.code = code;
  }
}

/**
 * What the office's «Информация» asks of the shell and the webview. Every
 * member is a function-typed property (`@typescript-eslint/unbound-method`);
 * a test passes its own through `AboutProvider`.
 */
export interface AboutApi {
  /** This build's version (`tauri.conf.json`), as the shell reports it. */
  appVersion: () => Promise<string>;
  /** The role the installer gave this PC (`install_role`). */
  installRole: () => Promise<InstallRole>;
  /** This PC's pairing (`device.json`): the host's address and id; `null` while unpaired. */
  pairing: () => Promise<DeviceStatus | null>;
  /** Asks the host at `address` for `hello` (`host_hello`); rejects when it does not answer. */
  hello: (address: string) => Promise<HelloObservation>;
  /** The operating system and the webview, from the webview itself. */
  system: () => Promise<SystemInfo>;
  /** Opens the site or a plain `mailto:` link in the system's program (`open_external_link`). */
  openLink: (link: string) => Promise<void>;
}

interface UserAgentData {
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>;
}

/**
 * Windows 10 and 11 both say «Windows NT 10.0» in the user agent; the
 * platform version of the client hints tells them apart (13 and up is
 * Windows 11).
 */
export async function readSystem(
  userAgent: string = navigator.userAgent,
  data: UserAgentData | undefined = (navigator as Navigator & { userAgentData?: UserAgentData })
    .userAgentData,
): Promise<SystemInfo> {
  let platformVersion: string | null = null;
  let architecture: string | null = null;
  let bitness: string | null = null;
  try {
    const high = await data?.getHighEntropyValues?.(["platformVersion", "architecture", "bitness"]);
    if (typeof high?.platformVersion === "string") platformVersion = high.platformVersion;
    if (typeof high?.architecture === "string") architecture = high.architecture;
    if (typeof high?.bitness === "string") bitness = high.bitness;
  } catch {
    // The hints are optional: the user agent alone still names the system.
  }
  let os: string;
  if (/Windows NT 10\.0/.test(userAgent)) {
    const major = platformVersion === null ? Number.NaN : Number.parseInt(platformVersion, 10);
    if (Number.isNaN(major)) os = "Windows 10 / 11";
    else os = major >= 13 ? "Windows 11" : "Windows 10";
  } else if (/Windows/.test(userAgent)) {
    os = "Windows";
  } else if (/Mac OS X/.test(userAgent)) {
    os = "macOS";
  } else if (/Linux/.test(userAgent)) {
    os = "Linux";
  } else {
    os = data?.platform ?? "—";
  }
  const edge = /Edg\/([\d.]+)/.exec(userAgent)?.[1];
  const arch =
    architecture === null
      ? null
      : architecture === "x86"
        ? bitness === "64"
          ? "x64"
          : "x86"
        : architecture;
  return { os, arch, webview: edge === undefined ? null : `WebView2 ${edge}` };
}

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/** Over the shell's commands. */
export function createTauriAboutApi(call: Invoke = invoke): AboutApi {
  const device = createTauriDeviceApi(call);
  const probe = createTauriHostProbe(call);
  return {
    appVersion: () => getVersion(),
    installRole: () => device.installRole(),
    pairing: () => device.status(),
    hello: (address) => probe.hello(address),
    system: () => readSystem(),
    openLink: async (link) => {
      try {
        await call("open_external_link", { link });
      } catch (error) {
        const code = EXTERNAL_LINK_CODES.find((candidate) => candidate === error);
        throw new ExternalLinkError(code ?? "launch", `open_external_link: ${String(error)}`);
      }
    },
  };
}
