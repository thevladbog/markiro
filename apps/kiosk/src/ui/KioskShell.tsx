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
import { readSnapshot, type CachedSnapshot } from "../store/cache.js";
import { readConfig, readScannerSettings, writeConfig, type KioskConfig } from "../store/config.js";
import { enqueueOrder, listQueue } from "../store/queue.js";
import {
  cacheAge,
  flushQueue,
  refreshSnapshot,
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
 * The live scan transport. `port === null` is the keyboard wedge.
 *
 * `epoch` counts transport changes and is `Idle`'s `key`: that screen
 * subscribes at mount and deliberately ignores a later `onScan`, so a remount
 * is the only way a swap can reach it.
 */
interface ScanTransport {
  port: SerialPort | null;
  epoch: number;
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
  const [transport, setTransport] = useState<ScanTransport>(() => ({ port: null, epoch: 0 }));

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
   * What the server answered for each order this shell submitted, recorded as
   * the reply passes through the client on its way to `flushQueue`.
   *
   * `flushQueue` returns nothing — it journals the verdict and moves on, which
   * is right for a drain nobody is watching. But the worker standing here IS
   * watching, and «Заявка № … передана» is the whole point of the confirmation,
   * so the one drain they are waiting on has to give its result back. Reading
   * it out of the journal afterwards would recover the number but not the
   * server's accepted `itemCount`, and re-deriving that from the conflicts
   * would put the server's arithmetic on the device.
   */
  const answers = useRef(new Map<number, CreateOrderResultDto>());

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
        answers.current.set(body.deviceSeq, result);
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
      // Only when a grant actually survived. Setting the state unconditionally
      // would hand back a NEW object for the unchanged keyboard transport and
      // rebuild the scan source under a screen that had already subscribed.
      if (port) setTransport((prev) => ({ port, epoch: prev.epoch + 1 }));
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
   * ONE `ScanSource` per transport, held rather than rebuilt.
   *
   * `ScannerSetup` lists its source in an effect's dependencies, and the
   * keyboard wedge accumulates the payload in the closure that a teardown
   * discards — so a source rebuilt on a re-render truncates whatever is being
   * scanned at that moment and a good scanner reports «не распознано». A ref
   * rather than `useMemo` because a memo is a cache React is allowed to drop,
   * and this identity is a contract.
   */
  const sourceRef = useRef<{ transport: ScanTransport; source: ScanSource } | null>(null);
  if (sourceRef.current === null || sourceRef.current.transport !== transport) {
    sourceRef.current = {
      transport,
      source:
        transport.port === null
          ? createKeyboardWedgeSource()
          : createWebSerialSource(transport.port),
    };
  }
  const scanSource = sourceRef.current.source;

  /**
   * The scanner, subscribed ONCE for the life of a transport and fanned out to
   * whichever screen is standing.
   *
   * `Idle` and `Cart` each subscribe at mount and unsubscribe at unmount, so
   * handing them `scanSource.start` directly would tear the wedge's window
   * listener down and put it back on every screen change — including the
   * Idle→Cart handover, which happens while the worker is still holding the
   * badge they just scanned. The listener set makes a screen change a set
   * membership change instead, and leaves the transport itself untouched.
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
        // DURABLE BEFORE ANY NETWORK ATTEMPT. The queue is what makes a pickup
        // survive a crash, a reload or a battery pull between here and the
        // server, and `flushQueue`'s acknowledge-then-remove is what makes the
        // replay safe. Submitting first and queueing on failure would lose the
        // order in exactly the window that matters.
        await enqueueOrder(body);
        // Then the counter, so the next order cannot reuse this idempotency key.
        const advanced = { ...cfg, nextDeviceSeq: deviceSeq + 1 };
        await writeConfig(advanced);
        applyConfig(advanced);
        await drain();
        // Delivered in that drain, or still queued. `null` is not a missing
        // number — it is the true statement that the server has not seen this
        // order, and `Done` says exactly that instead of inventing an «№ —».
        const result = answers.current.get(deviceSeq) ?? null;
        answers.current.clear();
        setSubmitted({ deviceSeq, result, itemCount: body.items.length });
      } catch (err) {
        // The store refused the order. Nothing was filed and nothing was
        // promised, so the worker stays on their cart and can press again.
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
  /** No snapshot at all counts as blocked: a paired device that cannot say how
   * old its dataset is must not hand product out on it. */
  const age: CacheAge = snapshot ? cacheAge(snapshot.bootstrap.generatedAt, now()) : "blocked";

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
        scanSource={scanSource}
        onTransportChange={(next, port) => {
          // The port travels up because only that screen's radio can obtain
          // one: `requestPort()` needs transient user activation, which the
          // shell never has. Dropping it here would kill the grant the
          // installer just gave with the screen that asked for it.
          setTransport((prev) => {
            const nextPort = next === "serial" ? (port ?? null) : null;
            return nextPort === prev.port ? prev : { port: nextPort, epoch: prev.epoch + 1 };
          });
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
        scanSource={scanSource}
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
        // Zero, honestly: the bootstrap carries no per-employee count of what
        // has already been taken today, so the device cannot know it. The
        // local limit therefore only counts this cart, which is all the local
        // pass ever claims to be — `POST /kiosk/orders` re-decides the day
        // limit against live data and its `conflicts[]` are authoritative.
        alreadyTakenToday={0}
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
        // Remounted when the transport changes, because this screen subscribes
        // at mount and deliberately ignores a later `onScan`.
        key={transport.epoch}
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
