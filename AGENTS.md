# Project conventions

- Use English for first-party documentation, comments, test names, package descriptions, logs and user-facing backend messages. Keep conversation language separate from project artifact language.
- Preserve incoming TikTok text and protocol literals. A language migration must not rename endpoints, SSE event names, payload fields or environment variables.
- `src/events.js` owns the shared live/simulated payload contract. Keep IDs as strings and unknown counters as `null`; keep `gift` as a string and `diamonds` as the completed combo total.
- Game rules belong to clients. Fetch no additional profiles or images merely to fill missing event fields.
- Document API changes in `docs/client-api.md` and integration changes in `docs/client-guide.md`. Run `npm test`; distinguish offline fixtures from real LIVE validation.
- Third-party dependencies in `node_modules/` and runtime history/evidence in `.pi/` are not project-authored translation targets.
