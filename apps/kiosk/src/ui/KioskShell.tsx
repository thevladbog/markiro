import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
// Imported from the module that owns the routing decision, which imports this
// file back to render it. The cycle is safe and deliberate: `nextKioskView` is
// a hoisted function declaration and nothing here runs at module scope, so the
// binding is initialised long before the component body can read it.
import { nextKioskView } from "../App.js";
import { createKioskClient, type KioskClient } from "../api/client.js";
import type { CreateOrderDto, CreateOrderResultDto } from "../api/types.js";
import { buildBadgeIndex, resolveBadge } from "../credentials/badge.js";
import { createKeyboardWedgeSource } from "../scanner/keyboard.js";
import type { ScanListener, ScanSource } from "../scanner/source.js";
import { createWebSerialSource, listGrantedPorts, type SerialPort } from "../scanner/web-serial.js";
import { Blocked } from "../screens/Blocked.js";
import { Cart } from "../screens/Cart.js";
import { Done } from "../screens/Done.js";
import { Idle } from "../screens/Idle.js";
import { Pairing } from "../screens/Pairing.js";
import { ScannerSetup } from "../screens/ScannerSetup.js";
import type { CartState } from "../session/cart.js";
import { countTakenToday, startOfUtcDay, utcDayOf } from "../session/day-count.js";
import { readSnapshot, type CachedSnapshot } from "../store/cache.js";
import { readConfig, readScannerSettings, writeConfig, type KioskConfig } from "../store/config.js";
import { readJournalSince } from "../store/journal.js";
import { enqueueOrder, listQueue } from "../store/queue.js";
import {
  flushQueue,
  refreshSnapshot,
  snapshotAge,
  REFRESH_INTERVAL_MS,
  type CacheAge,
} from "../sync/worker.js";
import { StatusStrip } from "./StatusStrip.js";

/** Matches the dev proxy in `vite.config.ts`; an on-prem install overrides it
 * from the pairing screen's server field, and the stored value wins after. */
const DEFAULT_SERVER_URL = "/api";

/** The device's own clock, in one place. Everything time-shaped downstream
 * (`cacheAge`, `flushQueue`'s journal stamps, an order's `createdAt`) takes it
 * as a parameter, so this is the shell's single reading of `Date`. */
const now = (): Date => new Date();

/** One worker, from the badge that admitted them to the confirmation they walk
 * away from. `badgeCode` is carried because `POST /kiosk/orders` re-resolves the
 * badge server-side — the employee id the device matched locally is not what the
 * server files the order under, and is never sent. */
interface KioskSession {
  /** Monotonic, and the `Cart`'s `key`: `cartReducer`'s `reset` action is
   * unreachable from the screen (nothing dispatches it), so a fresh instance is
   * the only way to give the next worker an empty list. */
  id: number;
  employeeId: string;
  fullName: string;
  badgeCode: string;
}

/** An order that has been filed, and what the server made of it — `null` when
 * it is still queued and the server has therefore said nothing at all. */
interface SubmittedOrder {
  deviceSeq: number;
  result: CreateOrderResultDto | null;
  itemCount: number;
}

/**
 * Recovers the transport a previous session settled on.
 *
 * Only the MODE is stored (`store/config.ts` explains why a `SerialPort` cannot
 * be), so "serial" alone is not enough to run on: the grant has to still exist
 * in the browser's permission store. When it does not — a reset profile, a
 * different machine, a scanner that was moved — the answer is the keyboard
 * wedge, NOT the stored mode. Honouring "serial" with no port would leave the
 * kiosk with no scanner at all, which at an unattended machine is
 * indistinguishable from a dead one.
 */
async function recoverGrantedPort(): Promise<SerialPort | null> {
  try {
    const saved = await readScannerSettings();
    if (saved?.transport !== "serial") return null;
    const ports = await listGrantedPorts();
    return ports[0] ?? null;
  } catch (err) {
    console.error("kiosk: could not recover the scanner transport", err);
    return null;
  }
}

/**
 * The device app itself: everything that reads a store, watches a clock or
 * touches the network, and nothing that decides.
 *
 * Every rule this shell appears to apply lives somewhere else and is tested
 * there without a DOM — `nextKioskView` picks the screen, `cacheAge` decides
 * what "too old" means, `cartReducer` decides what a scan does, `flushQueue`
 * owns the queue's invariants, and each screen owns its own copy. What is left
 * here is wiring, and the comments below are almost entirely about the shape
 * that wiring has to take for those pieces to keep their guarantees.
 */
export function KioskShell(): React.JSX.Element {
  const { t } = useTranslation();

  const [configLoaded, setConfigLoaded] = useState(false);
  const [config, setConfig] = useState<KioskConfig | null>(null);
  const [snapshot, setSnapshot] = useState<CachedSnapshot | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [queuedCount, setQueuedCount] = useState(0);
  const [scannerSetupRequested, setScannerSetupRequested] = useState(false);
  const [session, setSession] = useState<KioskSession | null>(null);
  const [submitted, setSubmitted] = useState<SubmittedOrder | null>(null);
  /** The live scan transport: `null` is the keyboard wedge, a port is Web Serial. */
  const [scanPort, setScanPort] = useState<SerialPort | null>(null);
  /**
   * What the signed-in worker has already taken today, counted off this
   * device's own history — and WHOSE session it was counted for.
   *
   * The session id is carried with the number because the read is async: an
   * answer that arrives late must not be spent by the next worker, and a
   * stale count belonging to the previous one is exactly the mis-attribution
   * this whole feature exists to avoid. Mismatched, it reads as zero, and a
   * zero here is the safe direction — see `countTakenToday`.
   */
  const [takenToday, setTakenToday] = useState<{ sessionId: number; count: number } | null>(null);

  /**
   * The config as the ASYNC work sees it. The refresh interval, the `online`
   * handler and the submit path all run outside a render and need the current
   * token and `nextDeviceSeq`; listing `config` in their dependencies instead
   * would restart the interval every time the counter advances.
   */
  const configRef = useRef<KioskConfig | null>(null);
  const applyConfig = useCallback((next: KioskConfig | null) => {
    configRef.current = next;
    setConfig(next);
  }, []);

  /**
   * The ONE order a worker is standing here waiting on, and what the server
   * answered for it — recorded as the reply passes through the client on its
   * way to `flushQueue`.
   *
   * `flushQueue` returns nothing — it journals the verdict and moves on, which
   * is right for a drain nobody is watching. But the worker standing here IS
   * watching, and «Заявка № … передана» is the whole point of the confirmation,
   * so the one drain they are waiting on has to give its result back. Reading
   * it out of the journal afterwards would recover the number but not the
   * server's accepted `itemCount`, and re-deriving that from the conflicts
   * would put the server's arithmetic on the device.
   *
   * ONE SLOT, not a map keyed by sequence. Every drain runs through this
   * client, including the unattended ones on the refresh interval and the
   * `online` handler, so a map would take an entry per order for the whole life
   * of the process and nothing outside `submitCart` would ever remove them — a
   * kiosk draining a long outage would accumulate one per queued order. Only
   * the submit in flight has a reader, `submitCart` is not re-entrant (the
   * `submitting` guard below), and every other answer is already journalled.
   */
  const awaited = useRef<{ deviceSeq: number; result: CreateOrderResultDto | null } | null>(null);

  /**
   * The API client, rebuilt per call because it holds nothing: `flushQueue` and
   * `refreshSnapshot` take it as an argument and neither keeps it.
   *
   * `null` when there is no token, and that is what keeps an unpaired device
   * off the network entirely — there is no request it could authenticate.
   */
  const clientFor = useCallback((cfg: KioskConfig | null): KioskClient | null => {
    if (!cfg?.token) return null;
    const base = createKioskClient({ token: cfg.token, serverUrl: cfg.serverUrl });
    return {
      // Called rather than passed along: `KioskClient` declares these as
      // methods, so handing the reference over would detach it from its object.
      bootstrap: () => base.bootstrap(),
      submitOrder: async (body) => {
        const result = await base.submitOrder(body);
        // Only the order somebody is waiting on. Everything else the drain
        // acknowledges is already in the journal, which is where a screen that
        // was not there at the time is supposed to read it from.
        const waiting = awaited.current;
        if (waiting?.deviceSeq === body.deviceSeq) waiting.result = result;
        return result;
      },
    };
  }, []);

  /** `Blocked` states this number for an administrator to reconcile against the
   * panel, so it is re-read after every drain rather than tracked by arithmetic
   * here. A failed read keeps the last known count: zeroing it would tell a
   * worker their orders had evaporated. */
  const refreshQueuedCount = useCallback(async () => {
    try {
      setQueuedCount((await listQueue()).length);
    } catch (err) {
      console.error("kiosk: could not count the queued orders", err);
    }
  }, []);

  const drain = useCallback(async () => {
    const client = clientFor(configRef.current);
    // NO `.catch()`: `flushQueue` never rejects (its own doc comment is
    // explicit about it, and about the asymmetry with `refreshSnapshot`), so a
    // catch here would be dead code claiming otherwise.
    if (client) await flushQueue(client, now);
    await refreshQueuedCount();
  }, [clientFor, refreshQueuedCount]);

  /**
   * One heartbeat: pull the dataset, then push whatever is owed.
   *
   * `refreshSnapshot` REJECTS on failure, and that rejection is the only signal
   * the device has that it is offline — uncaught it would take the whole kiosk
   * down five minutes after the network blinked. Caught, it is exactly what the
   * status strip reports, and nothing more: a failed drain says nothing here,
   * because `flushQueue` swallows the difference between a dead network and a
   * refused order and the strip must not invent a diagnosis out of it.
   */
  const sync = useCallback(async () => {
    const client = clientFor(configRef.current);
    if (client) {
      let reached = false;
      try {
        await refreshSnapshot(client, now);
        reached = true;
      } catch (err) {
        console.warn("kiosk: the snapshot could not be refreshed", err);
      }
      setOnline(reached);
      if (reached) {
        try {
          setSnapshot(await readSnapshot());
        } catch (err) {
          console.error("kiosk: the refreshed snapshot could not be read back", err);
        }
      }
    }
    await drain();
  }, [clientFor, drain]);

  /** Re-reads everything the device persists. Used at boot and again the moment
   * pairing writes a token and a dataset. */
  const reload = useCallback(async () => {
    try {
      const cfg = await readConfig();
      const snap = await readSnapshot();
      applyConfig(cfg);
      setSnapshot(snap);
    } catch (err) {
      // Nothing is rendered from a half-read store, and the device is not
      // stuck: an unreadable config reads as unpaired, which routes to the
      // pairing screen and a fresh code.
      console.error("kiosk: the device state could not be read", err);
    }
    await refreshQueuedCount();
  }, [applyConfig, refreshQueuedCount]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const port = await recoverGrantedPort();
      if (!alive) return;
      // Only when a grant actually survived; `null` is already the state and
      // re-setting it would rebuild the wedge under a screen that had
      // already subscribed to it.
      if (port) setScanPort(port);
      await reload();
      // Last, and deliberately after the reads: `configLoaded` is what ends the
      // loading screen, and flipping it early would flash the pairing screen at
      // a paired device on every boot.
      if (alive) setConfigLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, [reload]);

  /**
   * ONE `ScanSource` per transport, held rather than rebuilt, and OWNED HERE.
   *
   * This shell is the single owner of the device's scanner. No screen builds a
   * source, starts one, or is handed one — `createWebSerialSource` is
   * single-subscriber (`port.readable` is locked by the first reader), so a
   * second start on the running transport reads nothing at all, and reads it
   * silently: the screen sees no error, only a scanner that never speaks. Three
   * screens learned that the hard way, one symptom at a time.
   *
   * The identity is a contract, not an optimisation: subscribers list the
   * fan-out in effect dependencies, and the keyboard wedge accumulates the
   * payload in the closure a teardown discards — so a source rebuilt on a
   * re-render truncates whatever is being scanned at that moment and a good
   * scanner reports «не распознано». A ref rather than `useMemo` because a memo
   * is a cache React is allowed to drop.
   */
  const sourceRef = useRef<{ port: SerialPort | null; source: ScanSource } | null>(null);
  if (sourceRef.current === null || sourceRef.current.port !== scanPort) {
    sourceRef.current = {
      port: scanPort,
      source: scanPort === null ? createKeyboardWedgeSource() : createWebSerialSource(scanPort),
    };
  }
  const scanSource = sourceRef.current.source;

  /**
   * The scanner, subscribed ONCE for the life of a transport and fanned out to
   * whichever screens are standing.
   *
   * Every screen subscribes at mount and unsubscribes at unmount, so handing
   * one `scanSource.start` directly would tear the wedge's window listener down
   * and put it back on every screen change — including the Idle→Cart handover,
   * which happens while the worker is still holding the badge they just
   * scanned — and on Web Serial would not work at all. The listener set makes a
   * screen change a set membership change instead, and leaves the transport
   * itself untouched.
   *
   * It is also what makes a TRANSPORT change reach a screen that is already
   * standing. `subscribe` is stable and the set is transport-independent, so
   * swapping the source below re-points the fan-out under a mounted `Idle`
   * without touching its subscription — no remount, and therefore no `key`.
   * (An earlier revision carried an `epoch` on the transport for exactly that
   * remount; it was doing nothing, and removing it broke no test.)
   *
   * That same property is what lets `ScannerSetup`'s test scan certify the
   * transport an installer picked without holding a source of its own: the pick
   * swaps what this fan-out reads, so reading the fan-out afterwards IS reading
   * the new transport.
   *
   * Iterating a copy: a listener may unsubscribe (its screen may unmount)
   * during delivery, and mutating the set mid-walk would drop the next one.
   */
  const listeners = useRef(new Set<ScanListener>());
  const subscribe = useCallback((listener: ScanListener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  /**
   * The swap: React tears the OLD source down before starting the new one, and
   * the listener set is untouched by either — so a transport change is a change
   * of what the fan-out reads and nothing else. Stopping the old one is not
   * housekeeping: an abandoned Web Serial reader keeps `port.readable` locked,
   * and the next start of that same port would read nothing.
   */
  useEffect(() => {
    if (!scanSource.isAvailable()) return;
    return scanSource.start((raw) => {
      for (const listener of [...listeners.current]) listener(raw);
    });
  }, [scanSource]);

  const token = config?.token ?? null;
  const serverUrl = config?.serverUrl ?? null;
  useEffect(() => {
    // An unpaired device makes no request at all: there is nothing to
    // authenticate with, and every kiosk route but `/kiosk/pair` is guarded.
    if (token === null) return;
    // At boot as well as on the interval. A kiosk switched on in the morning
    // must not spend the first five minutes deciding from yesterday's roster.
    void sync();
    const timer = setInterval(() => void sync(), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [token, serverUrl, sync]);

  useEffect(() => {
    // `online` is the browser's word for "there is a link", which is worth
    // acting on immediately; `sync` then replaces it with what the server
    // actually answered, and drains whatever the outage left owed.
    const goOnline = () => {
      setOnline(true);
      void sync();
    };
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [sync]);

  /**
   * The day limit, answered from local history the moment a badge opens a
   * session — the journal's delivered orders plus whatever is still queued.
   *
   * Read HERE rather than in `Cart`, which owns no store access and is a
   * projection of `CartState`; the decision itself is `countTakenToday`'s, and
   * this is only the wiring that feeds it.
   *
   * ONCE PER SESSION is enough. Nothing this device can see changes a worker's
   * spent allowance while they stand at the cart except the cart itself, and
   * `remainingToday` already subtracts that.
   *
   * A failed read leaves the count where it was — at zero for a fresh session
   * — rather than refusing to open the cart. Guessing low costs a conflict on
   * an order the server refuses; guessing high turns a worker away at an
   * unattended machine with nobody to overrule it.
   */
  useEffect(() => {
    if (!session) return;
    const { id: sessionId, employeeId } = session;
    let alive = true;
    void (async () => {
      try {
        const at = now();
        const [journal, queued] = await Promise.all([
          readJournalSince(startOfUtcDay(at)),
          listQueue(),
        ]);
        if (!alive) return;
        setTakenToday({
          sessionId,
          count: countTakenToday({ employeeId, today: utcDayOf(at), journal, queued }),
        });
      } catch (err) {
        console.error("kiosk: could not count what this worker has taken today", err);
      }
    })();
    return () => {
      alive = false;
    };
  }, [session]);

  /**
   * The badge that opened the session, stashed by the resolver at the moment it
   * matched. `Idle.onEmployee` carries only the employee id — by design, it has
   * no business handling the credential — but `CreateOrderDto.badgeCode` is the
   * raw payload, because the server re-resolves it against live data. Recording
   * it inside the resolver keeps it consistent with the very snapshot the match
   * was made against, even if a refresh lands during the derivation.
   */
  const admitting = useRef<Omit<KioskSession, "id"> | null>(null);
  const sessions = useRef(0);

  /**
   * One submit per cart. `Cart` has no busy prop and its 84px button stays live
   * for as long as the submit takes, so the shell is the only thing standing
   * between a worker's second tap and a second order.
   *
   * A REF, not state, because the two halves of a double tap arrive in the same
   * tick and React has not re-rendered between them — a state flag would not be
   * visible to the second one.
   *
   * The tap that actually costs something is the LATER one. Two taps in the
   * same tick both read the same `nextDeviceSeq` (it only advances after the
   * order is durable), so the second merely re-files the first order under its
   * own idempotency key and the server returns the original. A tap that lands
   * after that write — while the POST is still in flight, which on a gate link
   * is seconds — reads the advanced counter and would file a genuinely second
   * order for one worker's bottles.
   */
  const submitting = useRef(false);

  const submitCart = useCallback(
    async (state: CartState, active: KioskSession) => {
      const cfg = configRef.current;
      if (!cfg) return;
      const deviceSeq = cfg.nextDeviceSeq;
      const body: CreateOrderDto = {
        deviceSeq,
        badgeCode: active.badgeCode,
        reason: state.reason,
        writeoffReasonId: state.writeoffReasonId,
        items: state.items.map((item) => ({ rawKm: item.rawKm })),
        // The scan time, not the sync time: an order queued through an outage
        // replays hours later and must still be filed under when it happened.
        createdAt: now().toISOString(),
      };
      try {
        // THE COUNTER FIRST, and this ordering is load-bearing.
        //
        // The two writes can only be torn apart one way or the other, and the
        // failure is ONE-SIDED. Burning a sequence nobody used costs nothing:
        // `(tenantId, kioskId, deviceSeq)` is the server's idempotency key and
        // it only has to be MONOTONIC, never dense, so a gap is invisible to
        // everything downstream. Reusing one is catastrophic and silent: the
        // server answers a repeated key by returning the FIRST order rather
        // than filing a second, so the next worker's whole cart evaporates and
        // `Done` confirms it to them under a stranger's order number.
        //
        // So the window this leaves — a config write that lands while the
        // order behind it does not — loses an order that was never promised:
        // nothing is queued, no confirmation is shown, and the worker is still
        // standing at a cart they can submit again. The reverse window loses an
        // order that WAS promised, to somebody who has already walked away.
        const advanced = { ...cfg, nextDeviceSeq: deviceSeq + 1 };
        await writeConfig(advanced);
        applyConfig(advanced);
        // DURABLE BEFORE ANY NETWORK ATTEMPT, and still before any of it. The
        // queue is what makes a pickup survive a crash, a reload or a battery
        // pull between here and the server, and `flushQueue`'s
        // acknowledge-then-remove is what makes the replay safe. Submitting
        // first and queueing on failure would lose the order in exactly the
        // window that matters.
        // The employee id travels with the record but NOT in the body: the
        // server re-resolves `badgeCode` and files the order under its own
        // answer, so this is device-local bookkeeping — it is what lets the
        // day count charge an order that has not synced yet to the worker who
        // took it, and what `flushQueue` copies into the journal.
        await enqueueOrder(body, active.employeeId);
        // From here on the server's answer for THIS order is worth keeping.
        awaited.current = { deviceSeq, result: null };
        await drain();
        // Delivered in that drain, or still queued. `null` is not a missing
        // number — it is the true statement that the server has not seen this
        // order, and `Done` says exactly that instead of inventing an «№ —».
        const result = awaited.current.result;
        awaited.current = null;
        setSubmitted({ deviceSeq, result, itemCount: body.items.length });
      } catch (err) {
        // The store refused. Nothing was promised, so the worker stays on their
        // cart and can press again — under the SAME sequence if the counter
        // write is the one that failed, under the next one if it succeeded and
        // the queue write did not. Neither path can use a sequence twice.
        awaited.current = null;
        console.error("kiosk: the order could not be filed", err);
      }
    },
    [applyConfig, drain],
  );

  /**
   * The roster and the digest index it was built from, kept together so they
   * cannot drift: a lookup answered from one snapshot's index against another
   * snapshot's rows would admit somebody the refresh had just removed.
   * Rebuilt per snapshot rather than per scan — `buildBadgeIndex` parses one
   * PHC string per employee, which is a full roster's worth of work.
   */
  const roster = useMemo(
    () =>
      snapshot
        ? { bootstrap: snapshot.bootstrap, index: buildBadgeIndex(snapshot.bootstrap) }
        : null,
    [snapshot],
  );

  const paired = Boolean(config?.token);
  // Including "no snapshot at all is blocked", which is `snapshotAge`'s rule
  // and is tested beside its NaN sibling in `sync/worker.ts` rather than here.
  const age: CacheAge = snapshotAge(snapshot, now());

  const view = nextKioskView({
    paired,
    cacheStale: age === "blocked",
    scannerSetupRequested,
    employeeId: session?.employeeId ?? null,
    submitted: submitted !== null,
    configLoaded,
  });

  let screen: React.JSX.Element;
  if (view === "loading") {
    screen = <main>{t("app.booting")}</main>;
  } else if (view === "scanner-setup") {
    screen = (
      <ScannerSetup
        paired={paired}
        bootstrap={snapshot?.bootstrap ?? null}
        // The fan-out, for both of that screen's readers — the gate's badge and
        // the test scan alike. Neither is given a source to start: this shell
        // owns the transport, and the swap below is what makes the test scan's
        // verdict belong to the transport the installer picked.
        subscribe={subscribe}
        onTransportChange={(next, port) => {
          // THE SWAP, and the whole reason that screen can certify anything.
          // The port travels up because only that screen's radio can obtain
          // one: `requestPort()` needs transient user activation, which the
          // shell never has. Dropping it here would kill the grant the
          // installer just gave with the screen that asked for it — and would
          // leave the test scan certifying the transport the pick replaced.
          setScanPort(next === "serial" ? (port ?? null) : null);
        }}
        // Closing UNMOUNTS this screen — the views are exclusive — so the next
        // visit re-runs its `useState(!paired)` and the operator gate is shut
        // again. An unattended settings screen left unlocked behind an idle
        // kiosk is the whole reason that gate exists.
        onClose={() => setScannerSetupRequested(false)}
      />
    );
  } else if (view === "pairing") {
    screen = (
      <Pairing
        defaultServerUrl={config?.serverUrl ?? DEFAULT_SERVER_URL}
        // The commissioning order is scanner setup FIRST, then pairing (design
        // brief 07 §5), precisely so the pairing barcode can be scanned — so
        // this screen is routinely the first consumer of a freshly granted
        // serial port, and must read it through the fan-out like everyone else.
        subscribe={subscribe}
        onPaired={() => void reload()}
        onConfigureScanner={() => setScannerSetupRequested(true)}
      />
    );
  } else if (view === "blocked") {
    screen = <Blocked queuedCount={queuedCount} />;
  } else if (view === "done" && submitted) {
    screen = (
      <Done
        // Per order. `Done`'s "already reset" flag is a sticky ref, so a re-used
        // instance never auto-resets again and the second worker's confirmation
        // would stand until somebody pressed the button.
        key={submitted.deviceSeq}
        // Passed through untouched: an accepted order, an order still queued
        // (`null`) and one the server refused outright (`orderNo: ""`) are three
        // different things to tell the worker, and that screen is where the
        // distinction is made.
        result={submitted.result}
        itemCount={submitted.itemCount}
        onReset={() => {
          setSubmitted(null);
          setSession(null);
        }}
      />
    );
  } else if (view === "cart" && session && snapshot) {
    screen = (
      <Cart
        key={session.id}
        employee={{ id: session.employeeId, fullName: session.fullName }}
        bootstrap={snapshot.bootstrap}
        // Counted off this device's own order journal and its unsynced queue,
        // which is what the design asks for: the local day limit is
        // «best-effort по локальному журналу заявок киоска (сервер остаётся
        // авторитетом)» (design 2026-07-24 §7). It can only MISS withdrawals —
        // another kiosk's, or history older than the journal keeps — never
        // invent one, and missing them is the safe direction because
        // `POST /kiosk/orders` re-decides the limit against live data and its
        // `conflicts[]` are authoritative either way.
        //
        // Zero until the read lands (and if it fails), for the same reason.
        alreadyTakenToday={takenToday?.sessionId === session.id ? takenToday.count : 0}
        onScan={subscribe}
        onSubmit={(state) => {
          if (submitting.current) return;
          submitting.current = true;
          void submitCart(state, session).finally(() => {
            submitting.current = false;
          });
        }}
        onNotMe={() => setSession(null)}
      />
    );
  } else {
    // `idle`, and the resting screen for the two states that cannot occur:
    // a cart with no session and a confirmation with no order. Idle is the one
    // screen that is safe to show a stranger.
    screen = (
      <Idle
        onScan={subscribe}
        resolveBadge={async (raw) => {
          if (!roster) return null;
          const employeeId = await resolveBadge(raw, roster.bootstrap, roster.index);
          if (employeeId === null) return null;
          const employee = roster.bootstrap.employees.find((one) => one.id === employeeId);
          // Unreachable — the id came from an index built over these very rows
          // — but a session with no name to show is not one to open.
          if (!employee) return null;
          admitting.current = { employeeId, fullName: employee.fullName, badgeCode: raw };
          return employeeId;
        }}
        onEmployee={() => {
          const admitted = admitting.current;
          if (!admitted) return;
          admitting.current = null;
          sessions.current += 1;
          setSession({ id: sessions.current, ...admitted });
        }}
        // The ONLY way back into scanner setup once a kiosk is running: the
        // pairing screen's own entry is gone the moment the device is paired,
        // and without this a kiosk whose scanner fails afterwards could be
        // recovered only by unbinding it from the cabinet. Offered on IDLE and
        // nowhere else — it is the screen an unattended kiosk rests on, and a
        // worker mid-cart must not lose their cart to a stray press.
        //
        // This raises the request; it grants nothing. `ScannerSetup` still
        // opens locked on a paired device (Task 11's second tier) and is
        // unmounted on close, so returning to idle re-shuts the gate.
        onOpenSettings={() => setScannerSetupRequested(true)}
      />
    );
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* On the working screens only. Before pairing there is no dataset to
          state an age for and no authenticated link to report on, and the
          installer screens would only be reading a strip about a device that is
          not yet a kiosk. */}
      {view === "idle" || view === "cart" || view === "done" || view === "blocked" ? (
        <StatusStrip online={online} age={age} />
      ) : null}
      {screen}
    </div>
  );
}
