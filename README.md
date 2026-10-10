# Aamil Farms Pond Ledger (frontend)

Installable PWA for pond records, water quality alerts, feed and FCR, and finances for pangasius and IMC culture. English and Hindi.

- Static site: no build step. Host the repository root as a static site.
- Set the backend address in `config.js` (`window.API_BASE`).
- Works offline: entries are saved on the phone and sync when the connection returns.
- Backend: https://github.com/aamilsfarm-tech/aamilfarms-backend

After changing any app file, bump `CACHE` in `sw.js` so installed copies pick up the update.
