# October 2026 source update

Published source includes independent Lyrion presence/scrobbling through the Rabbit Hole metadata API, Roon fallback selection, single-instance ownership, exact artwork matching and retries, bridge rendering and Discord metadata updates. It does not read another copy of the playback audio stream.

Validation in an isolated publication checkout: npm ci --ignore-scripts succeeds after repairing a malformed optional register-scheme lockfile entry; npm run check checks 35 JavaScript files; npm test passes 205/205 with no skips. Native install scripts, Discord connectivity, real playback and launcher rebuilds were not exercised by this publication. The existing runtime was not restarted or redeployed.

Known dependency debt: npm audit reports one high-severity dependency finding for optional sharp 0.34.5; it recommends 0.35.5. That dependency/runtime compatibility upgrade remains separate from this source synchronization. The image-rendering fallback remains available without sharp. Do not describe this as a clean security audit.

Private .env, caches, credentials, scrobble state and local context are excluded. Configure your own public artwork hostname; the examples use a placeholder. Before a future runtime update, preserve local configuration, check the selected Roon/Lyrion route and validate Discord and Last.fm behavior with deliberate playback. GitHub source publication alone does not establish installation or live activation.
