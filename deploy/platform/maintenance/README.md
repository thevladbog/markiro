# Timeweb rollout storage

## Docker retention

The systemd timer runs every six hours in UTC. The service limits a run to
four candidates and reclaims images only if the Docker filesystem has less
than 12 GiB available. It reads the hash-bound successful rollout history,
keeps the current and immediately preceding API and edge images locally, and
accounts for running containers, stopped containers, and incomplete rollout
records. Tagged images and images with unrelated digests are ineligible.

Every candidate needs the exact GHCR manifest with its expected image ID and
an accessible config and layer blobs. The service rechecks the rollout history
and the Docker inventory under the host deployment lock before running
`docker image rm --no-prune`. An unavailable registry or a held deployment
lock defers cleanup. A low disk reading with no eligible images is recorded as
`belowTarget` in the service journal.

```sh
python3 -I /opt/markiro-platform/maintenance/image_retention.py
systemctl list-timers markiro-image-retention.timer
journalctl -u markiro-image-retention.service --no-pager -n 20
```

The first command produces a plan. The systemd service uses `--apply` to reclaim
eligible images. For maintenance, disable the timer with
`systemctl disable --now markiro-image-retention.timer`.

## Cold archives

The archival script covers the image tarballs of the two historical manual
rollouts identified in `SCOPE`. The current rollback, the latest complete
manual rollout, all PostgreSQL copies, worker archives, volumes, and
deployment journals stay on the VM.

Each tarball is encrypted with an off-host recovery certificate and uploaded
to the private, versioned `markiro-tmp-media` bucket under
`ops/rollout-archive/v1/`. The script streams a GET by VersionId, compares its
size and SHA-256 to the upload, then saves a JSON receipt alongside the
archive in S3 and under `/opt/markiro-platform/maintenance/receipts/`. The
retirement command repeats the full readback and matches the original file
before removing each local copy. Keep the encrypted recovery private key and
its passphrase available to the recovery operator outside Timeweb.

## Restore a cold archive

1. Locate the required original path in a receipt from the VM or in the S3
   archive prefix. Fetch the `key` with the receipt's `object.version` rather
   than fetching the latest object of that name. Timeweb's object manager
   supports downloading a particular version from the version history. A
   running Markiro host with the same storage credentials also supports
   `python3 -I /opt/markiro-platform/maintenance/archive-rollouts.py download OPERATION FILE`.
   Redirect its standard output to a private file.
2. Compare the ciphertext size and SHA-256 with `object.bytes` and
   `object.sha256`. In a private directory on the recovery workstation,
   decrypt using OpenSSL 3 with the recovery certificate and private key.

   ```sh
   umask 077
   openssl cms -decrypt -binary -inform DER -in downloaded.cms \
     -recip "$HOME/Markiro-Recovery/rollout-archive-recipient.pem" \
     -inkey "$HOME/Markiro-Recovery/rollout-archive-private.pem" \
     -out verified-image.tar
   ```

3. Compare the result with `plainBytes` and `plainSha256` before using or
   transferring it. For a manual rollback, restore it at `relativePath`
   beneath `/opt/markiro-platform/`, with the recorded owner and file mode.
   Verify the SHA-256 once more on the recovery host. Then use the original
   rollback procedure for that rollout. Keep the independent database
   restore checks from that procedure.
