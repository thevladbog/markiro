import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertSupersedes,
  buildHandheldManifest,
  HANDHELD_CHANNELS,
  handheldChannelBaseUrl,
  parseHandheldManifest,
} from "../manifest.mjs";

const valid = {
  versionName: "0.2.0",
  versionCode: 2,
  sha256: "a".repeat(64),
  bytes: 67_000_000,
  url: "https://releases.markiro.app/handheld/stable/releases/0.2.0/markiro-tsd-0.2.0.apk",
  notes: "Первая раздача",
  releasedAt: "2026-09-12T10:00:00.000Z",
  sourceSha: "b".repeat(40),
};

test("a manifest round-trips through JSON unchanged", () => {
  const manifest = buildHandheldManifest(valid);
  assert.deepEqual(parseHandheldManifest(JSON.stringify(manifest)), manifest);
});

test("every field the installer needs is present and no others", () => {
  const manifest = buildHandheldManifest(valid);
  assert.equal(
    Object.keys(manifest).sort().join(","),
    "bytes,notes,releasedAt,sha256,sourceSha,url,versionCode,versionName",
  );
});

test("an unknown field is refused rather than carried", () => {
  const text = JSON.stringify({ ...buildHandheldManifest(valid), rollout: "10%" });
  assert.throws(() => parseHandheldManifest(text));
});

test("a manifest without a digest is refused", () => {
  assert.throws(() =>
    parseHandheldManifest(JSON.stringify({ versionCode: 2, versionName: "0.2.0" })),
  );
});

test("a versionCode outside a positive int32 is refused", () => {
  for (const versionCode of [0, -1, 2 ** 31, 1.5, "2", null]) {
    assert.throws(
      () => buildHandheldManifest({ ...valid, versionCode }),
      undefined,
      `accepted ${String(versionCode)}`,
    );
  }
  assert.doesNotThrow(() => buildHandheldManifest({ ...valid, versionCode: 2 ** 31 - 1 }));
});

test("a digest that is not 64 lowercase hex is refused", () => {
  for (const sha256 of ["A".repeat(64), "a".repeat(63), "a".repeat(65), "", "g".repeat(64)]) {
    assert.throws(
      () => buildHandheldManifest({ ...valid, sha256 }),
      undefined,
      `accepted ${sha256}`,
    );
  }
});

test("a source commit that is not 40 hex is refused", () => {
  // It is the only link from an installed build back to a commit; a blank or a
  // short one makes «какая сборка стоит на терминале» unanswerable.
  for (const sourceSha of ["b".repeat(39), "", "B".repeat(40), null]) {
    assert.throws(() => buildHandheldManifest({ ...valid, sourceSha }));
  }
});

test("the download URL must live under the channel it is published to", () => {
  assert.throws(() =>
    buildHandheldManifest({
      ...valid,
      url: "https://releases.markiro.app/handheld/beta/releases/0.2.0/markiro-tsd-0.2.0.apk",
    }),
  );
  assert.throws(() =>
    buildHandheldManifest({ ...valid, url: "http://releases.markiro.app/handheld/stable/x.apk" }),
  );
  assert.throws(() => buildHandheldManifest({ ...valid, url: "https://example.test/x.apk" }));
});

test("a beta manifest is accepted under the beta channel", () => {
  const manifest = buildHandheldManifest({
    ...valid,
    channel: "beta",
    url: `${handheldChannelBaseUrl("beta")}/releases/0.2.0/markiro-tsd-0.2.0.apk`,
  });
  assert.equal(manifest.versionName, "0.2.0");
  assert.deepEqual(HANDHELD_CHANNELS, ["stable", "beta"]);
});

test("an unknown channel is refused", () => {
  assert.throws(() => handheldChannelBaseUrl("nightly"));
  assert.throws(() => buildHandheldManifest({ ...valid, channel: "nightly" }));
});

test("a version name that is not three numbers is refused", () => {
  for (const versionName of ["0.2", "0.2.0-rc1", "v0.2.0", ""]) {
    assert.throws(() => buildHandheldManifest({ ...valid, versionName }));
  }
});

test("empty release notes are refused", () => {
  // A published build with nothing to say about it is how a line ends up asking
  // the office what changed.
  for (const notes of ["", "   ", null]) {
    assert.throws(() => buildHandheldManifest({ ...valid, notes }));
  }
});

test("publishing must raise the versionCode", () => {
  const published = JSON.stringify(buildHandheldManifest(valid));
  assert.doesNotThrow(() =>
    assertSupersedes(published, buildHandheldManifest({ ...valid, versionCode: 3 })),
  );
  for (const versionCode of [2, 1]) {
    assert.throws(
      () => assertSupersedes(published, buildHandheldManifest({ ...valid, versionCode })),
      undefined,
      `accepted ${versionCode}`,
    );
  }
});

test("the first release of a channel supersedes nothing", () => {
  assert.doesNotThrow(() =>
    assertSupersedes(null, buildHandheldManifest({ ...valid, versionCode: 1 })),
  );
});

test("an unreadable published manifest stops the release instead of being ignored", () => {
  // Treating a corrupt pointer as «no previous release» would let a lower
  // versionCode through, and every installed terminal would refuse the update
  // with nothing on the publishing side having noticed.
  for (const published of ["not json", "{}", JSON.stringify({ versionCode: 4 })]) {
    assert.throws(() => assertSupersedes(published, buildHandheldManifest(valid)));
  }
});
