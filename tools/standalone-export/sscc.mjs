/**
 * SSCC and shift-number arithmetic of the cloud → standalone move (pilot spec
 * §8.4, §8.5). Pure: the caller passes what `export.sql` read.
 *
 * A serial the cloud ever handed out under a prefix and an extension must
 * never be printed again by the standalone. The cloud's `sscc_counters`
 * marks where its NEXT BLOCK is cut, and a reseed may have moved it below a
 * block it revoked or below boxes printed before blocks existed, so the
 * highest serial ever handed out is the largest of three numbers: the
 * counter minus one, the highest end of any block (revoked ones included),
 * and the highest serial on a box or a pallet of the tenant. The standalone
 * starts one above it, rounded up to the next 10 000, so its first SSCC is
 * told apart at a glance and the gap absorbs anything the cloud printed but
 * never reported. The cloud's counter then moves past a window the
 * standalone fills, so a rollback (§8.10) never prints a serial twice.
 *
 * Every number is checked before it is used: a value that is no whole serial
 * (a string, `NaN`, a negative number) would turn the maximum into `NaN` and
 * the start into a number nobody checked, so the export stops instead.
 */

/** Serials after a 9-digit issuer prefix: 16 − 9 = 7 digits. */
export const SERIAL_CAPACITY = 10_000_000;
/** The standalone's first serial is a multiple of this. */
export const START_STEP = 10_000;
/** Owner question П6, recommended answer A: the rollback windows. */
export const BOX_WINDOW = 1_000_000;
export const PALLET_WINDOW = 100_000;

/** Both the cloud (`deriveIssuerPrefix`) and the standalone cut the prefix from a GLN: 9 digits. */
const ISSUER_PREFIX = /^\d{9}$/u;

function checkExtension(extension) {
  if (extension !== 0 && extension !== 1) {
    throw new RangeError(
      `extension digit ${String(extension)} is neither 0 (boxes) nor 1 (pallets)`,
    );
  }
}

function checkIssuerPrefix(issuerPrefix) {
  if (typeof issuerPrefix !== "string" || !ISSUER_PREFIX.test(issuerPrefix)) {
    throw new RangeError(
      `issuer prefix ${JSON.stringify(issuerPrefix)} is not 9 digits: its serials are not 7 digits wide`,
    );
  }
}

/** `null` (nothing there) or a whole number from 0 to `max`; anything else stops the export. */
function checkSerial(name, value, max) {
  if (value === null) return;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${name} ${String(value)} is not a whole serial number in 0..${max}`);
  }
}

function largest(left, right) {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

/** The first serial of an extension digit: boxes start at 1, pallets at 0. */
export function firstSerial(extension) {
  checkExtension(extension);
  return extension === 0 ? 1 : 0;
}

/**
 * The highest serial the cloud ever handed out, or `null` when it never
 * handed one out. `counterNext` is `sscc_counters.next_serial` (or `null`
 * without a row), `blockMax` the largest `sscc_blocks.to_serial`, `printedMax`
 * the largest serial on a box or a pallet.
 */
export function issuedMax({ extension, counterNext, blockMax, printedMax }) {
  checkExtension(extension);
  checkSerial("counterNext", counterNext, SERIAL_CAPACITY);
  checkSerial("blockMax", blockMax, SERIAL_CAPACITY - 1);
  checkSerial("printedMax", printedMax, SERIAL_CAPACITY - 1);
  const candidates = [];
  if (counterNext !== null && counterNext - 1 >= firstSerial(extension)) {
    candidates.push(counterNext - 1);
  }
  if (blockMax !== null) candidates.push(blockMax);
  if (printedMax !== null) candidates.push(printedMax);
  return candidates.length === 0 ? null : Math.max(...candidates);
}

/**
 * Where the standalone's counter starts: the extension's first serial when
 * the cloud handed out none, else one above the highest, rounded up to the
 * next multiple of `START_STEP` (a serial already on such a multiple stays).
 */
export function standaloneStart(extension, issued) {
  checkExtension(extension);
  if (issued === null) return firstSerial(extension);
  checkSerial("issued", issued, SERIAL_CAPACITY - 1);
  return Math.ceil((issued + 1) / START_STEP) * START_STEP;
}

/** The rollback window of an extension. */
export function windowOf(extension, windows = { box: BOX_WINDOW, pallet: PALLET_WINDOW }) {
  checkExtension(extension);
  const window = extension === 0 ? windows.box : windows.pallet;
  if (!Number.isSafeInteger(window) || window <= 0) {
    throw new RangeError(
      `the rollback window ${String(window)} of extension ${extension} is not a positive whole number`,
    );
  }
  return window;
}

/**
 * Where the cloud's counter moves after the export: past the standalone's
 * window. `null` when that would leave the prefix's serials: the window does
 * not fit, and the owner decides (pilot spec §8.10, «без окна»).
 */
export function cloudReseedTo(start, extension, windows) {
  const target = start + windowOf(extension, windows);
  return target < SERIAL_CAPACITY ? target : null;
}

/**
 * One row per (prefix, extension) the tenant has a counter, a block or a
 * printed SSCC of, and always both extensions of `organizationPrefix` (the
 * first 9 digits of the organization's GLN; `null` only where no organization
 * is meant). `counters`, `blocks` and `printed` are `export.sql`'s arrays;
 * `owners` names whose prefix it is. Rows come by prefix, then extension.
 * Several rows of one key keep the largest number of each kind.
 *
 * The organization's two rows stand even when the cloud never issued under
 * an extension (pallets came late): the standalone issues under both, so
 * the cut-over must move both cloud counters past its window, or a rollback
 * would cut the cloud's first block over serials the standalone printed.
 * Such a row starts at the extension's first serial.
 *
 * Throws when the cloud already used the whole prefix (the standalone could
 * never issue under it), for a prefix that is not 9 digits, for an extension
 * other than 0 and 1, for a number that is no serial, and when
 * `organizationPrefix` is missing (`undefined`).
 */
export function planSsccCounters(
  { organizationPrefix, counters, blocks, printed },
  owners,
  windows,
) {
  if (organizationPrefix === undefined) {
    throw new RangeError("organizationPrefix is required (null when there is no organization)");
  }
  const rows = new Map();
  const row = (issuerPrefix, extension) => {
    checkIssuerPrefix(issuerPrefix);
    const key = `${issuerPrefix}:${extension}`;
    if (!rows.has(key)) {
      rows.set(key, {
        issuerPrefix,
        extension,
        counterNext: null,
        blockMax: null,
        consumedMax: null,
        printedMax: null,
      });
    }
    return rows.get(key);
  };
  const within = (issuerPrefix, extension, run) => {
    try {
      return run();
    } catch (error) {
      throw new RangeError(`prefix ${issuerPrefix}, extension ${extension}: ${error.message}`, {
        cause: error,
      });
    }
  };
  if (organizationPrefix !== null) {
    row(organizationPrefix, 0);
    row(organizationPrefix, 1);
  }
  for (const counter of counters) {
    const each = row(counter.issuerPrefix, counter.extension);
    within(each.issuerPrefix, each.extension, () => {
      checkSerial("counterNext", counter.nextSerial, SERIAL_CAPACITY);
      each.counterNext = largest(each.counterNext, counter.nextSerial);
    });
  }
  for (const block of blocks) {
    const each = row(block.issuerPrefix, block.extension);
    within(each.issuerPrefix, each.extension, () => {
      checkSerial("blockMax", block.maxToSerial, SERIAL_CAPACITY - 1);
      checkSerial("maxConsumedThrough", block.maxConsumedThrough, SERIAL_CAPACITY - 1);
      each.blockMax = largest(each.blockMax, block.maxToSerial);
      each.consumedMax = largest(each.consumedMax, block.maxConsumedThrough);
    });
  }
  for (const code of printed) {
    const each = row(code.issuerPrefix, code.extension);
    within(each.issuerPrefix, each.extension, () => {
      checkSerial("printedMax", code.maxSerial, SERIAL_CAPACITY - 1);
      each.printedMax = largest(each.printedMax, code.maxSerial);
    });
  }
  return [...rows.values()]
    .sort((a, b) =>
      a.issuerPrefix === b.issuerPrefix
        ? a.extension - b.extension
        : a.issuerPrefix < b.issuerPrefix
          ? -1
          : 1,
    )
    .map((each) => {
      // A consumed serial is on a printed box: it lies inside its block, but a
      // damaged row must not let the standalone reuse it.
      const issued = within(each.issuerPrefix, each.extension, () =>
        issuedMax({
          extension: each.extension,
          counterNext: each.counterNext,
          blockMax: largest(each.blockMax, each.consumedMax),
          printedMax: each.printedMax,
        }),
      );
      const start = standaloneStart(each.extension, issued);
      if (start >= SERIAL_CAPACITY) {
        throw new Error(
          `the cloud used every serial of prefix ${each.issuerPrefix}, extension ${each.extension}: ` +
            `the next start would be ${start} but serials end at ${SERIAL_CAPACITY - 1}`,
        );
      }
      return {
        issuerPrefix: each.issuerPrefix,
        extension: each.extension,
        owner: owners(each.issuerPrefix),
        issuedMax: issued,
        printedMax: largest(each.consumedMax, each.printedMax),
        standaloneStart: start,
        cloudReseedTo: cloudReseedTo(start, each.extension, windows),
      };
    });
}

const MONTH_KEY = /^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{2}$/u;

/**
 * The cloud's shift-number counters the standalone continues (§8.5): every
 * month the cloud drew a number in, so a backdated production date continues
 * the cloud's numbering too. A counter that never drew a number (0) or a key
 * that is no `MONYY` is left out; a month named twice keeps the larger
 * counter, so a number is never drawn again. By month key.
 */
export function planShiftNumberCounters(counters) {
  const byMonth = new Map();
  for (const each of counters) {
    if (!MONTH_KEY.test(each.monthKey) || !Number.isInteger(each.lastSeq) || each.lastSeq <= 0) {
      continue;
    }
    byMonth.set(each.monthKey, Math.max(byMonth.get(each.monthKey) ?? 0, each.lastSeq));
  }
  return [...byMonth.entries()]
    .map(([monthKey, lastSeq]) => ({ monthKey, lastSeq }))
    .sort((a, b) => (a.monthKey < b.monthKey ? -1 : a.monthKey > b.monthKey ? 1 : 0));
}
