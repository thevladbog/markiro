# Online updates in Автоном Office

User-approved scope: add manual check and download in Information → Updates, retain file import and install using the existing administrator confirmation, fresh Host backup and installer verification.

The shell contacts only https://releases.markiro.app/standalone/{stable|beta}/ after an explicit click. Stable is default; beta requires selection. No polling, credentials, site facts or telemetry. Offline factory operation and manual import remain available. The unsigned latest.json is discovery only: verify its referenced JWS with embedded update keys, match version/channel/size/hash, display only signed notes, and reject foreign URLs or redirects. Bound metadata (64 KiB), installer (256 MiB), connect/read/overall times, and concurrent downloads. Resume partials only for the same signed manifest; hash the entire file before promotion. Keep Internet downloads separate from Host downloads so existing host-version equality rules do not misclassify them. Installation remains an explicit administrator action using UpdateSection's existing report/confirmation/runUpdate.

No new dependencies, cloud API changes, publication or deployment. Windows UAC/NTFS and live CDN remain external acceptance gates.

## Owner follow-up: automatic Host staging

After an Internet download and successful local signature/hash verification, automatically
upload the package to the paired Host using the current administrator session and existing
update_stage IPC. Never stage failed verification or a result received after leaving the section.
Show transfer status and a separate retry using the downloaded local package. Block installation
while transfer runs, retain explicit installation confirmation and Host backup, and retain manual
upload for manually imported packages. A lost upload response is recoverable: package_not_newer
is success only if a fresh Host status confirms the exact downloaded version as verified current
or staged. Host distribution still starts only when Host runs that package's version.
