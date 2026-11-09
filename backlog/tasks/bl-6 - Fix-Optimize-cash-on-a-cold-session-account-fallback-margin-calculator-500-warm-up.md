---
id: BL-6
title: >-
  Fix Optimize cash on a cold session: account fallback + margin-calculator 500
  warm-up
status: Done
assignee:
  - Tiger
created_date: '2026-11-09 14:49'
updated_date: '2026-11-09 15:55'
labels: []
dependencies: []
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Two independent failures make the Optimize cash button unusable on a fresh/cold session. (1) Fidelity's margin-calculator backend returns 500 "Unknown System Exception" for every endpoint (current-status/v1, accounts/v1, trade-calculator/v1) until the margin-calculator page itself has been loaded once in the session — its load sequence creates server-side state the API requires (verified live: identical request bodies 500 before visiting the page, 200 after, persisting across navigations; not Referer, not request shape). This breaks the whole extension, not just Optimize cash. (2) The always-visible Optimize cash FAB resolves its account only from the URL hash and two storage keys, with no accounts/v1 fallback (chain-core.js getAccount already implements the full fallback chain), so on a session where nothing is stored it errors with "Could not determine the account for this row" while the per-row buttons work.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The always-visible Optimize cash button resolves an account via the accounts/v1 fallback (open ticket → last-used → Fidelity default) instead of failing with "Could not determine the account for this row" on a session with nothing stored
- [x] #2 When current-status/v1, trade-calculator/v1 or accounts/v1 returns a retryable 5xx, the extension warms the backend (hidden margin-calculator page load) once and the existing retry then succeeds, instead of surfacing "HTTP 500 — try again in a minute"
- [x] #3 Warm-up is deduplicated: concurrent failing calls and repeated failures within the cooldown window open at most one hidden tab; the tab is always closed afterwards
- [x] #4 A genuine Fidelity outage still surfaces the plain-language error message (warm-up failure does not mask or change the error path)
- [x] #5 All modified files pass node --check; CLAUDE.md API notes updated to record the cold-session 500 behavior
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Plan (researched against current code, 2026-11-09):

1. **FAB account fallback** — content/mmf.js `pageAccount()`: keep URL-hash first, then delegate to `ChainCore.getAccount()` (content/chain-core.js, loaded earlier in the same content-script world; it already implements open-ticket → stored → accounts/v1 with retry/backoff and persists the result).

2. **Margin-calculator 5xx warm-up**:
   - lib/constants.js: add `MESSAGE_TYPES.WARM_MARGIN_CALC` and `API.MARGIN_CALCULATOR_PAGE_URL`.
   - New lib/margin-warmup.js (content world; added to manifest js list before positions.js/margin-api.js):
     - `MarginWarmup.ensureWarm()` — per-page dedup via in-flight promise + success cooldown; asks the background with a 30 s timeout; never rejects (resolves false).
     - Also listens for a background→tab probe message (`WARM_PROBE`): when the background opens the hidden margin-calculator tab, this listener answers by fetching accounts/v1 in page context (same-origin cookies) and reporting ok — the readiness signal the background polls.
   - background.js: `WARM_MARGIN_CALC` handler — global dedup + cooldowns (success 5 min, failure 60 s); opens the margin-calculator page in an inactive tab, polls the tab via `chrome.tabs.sendMessage` WARM_PROBE until accounts/v1 answers ok (≤ ~25 s), always closes the tab, responds `{ok}`.
   - Wire-in points (await `MarginWarmup.ensureWarm()` when the failing status is ≥ 500, before throwing the retryable error, so the existing Retry.withBackoff retry lands on a warm backend):
     - lib/positions.js `doFetchPriceList` retryable branch
     - lib/margin-api.js `doFetch` non-OK branch
     - content/chain-core.js `fetchDefaultAccount` retryable-status branch
   - Never changes error typing/messages: warm-up failure leaves the existing plain-language error path untouched.

3. **Docs** — CLAUDE.md API section: replace "API works from any digital.fidelity.com page" with the cold-session 500 behavior + warm-up note.

Risks/notes: background cannot fetch digital.fidelity.com reliably from the SW (CORS/Origin), hence the tab-probe design; warm-up adds up to ~30 s latency only in the state where calls would otherwise fail outright; hidden tab is closed in a finally.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implementation complete (2026-11-09), pending review + commit:

- lib/margin-warmup.js (new): MarginWarmup.ensureWarm() — per-page dedup via in-flight promise, 5-min success cooldown, 35s ask timeout, never rejects. Also hosts the WARM_PROBE onMessage listener that runs the accounts/v1 readiness probe in page context (background can't call the API itself — extension-origin requests rejected).
- background.js: WARM_MARGIN_CALC handler — global dedup, 5-min success / 60s failure cooldowns, hidden tab via chrome.tabs.create({active:false}), polls probeWarmTab() every 1.5s up to 30s, always closes the tab, responds {ok} (never an error object).
- Wire-ins (await ensureWarm() when status ≥ 500, before throwing the retryable error): lib/positions.js doFetchPriceList, lib/margin-api.js doFetch, lib/chain-api.js fetchOnce, content/chain-core.js fetchDefaultAccount.
- FAB fix: content/mmf.js pageAccount() → URL hash first, else ChainCore.getAccount() (open ticket → stored → accounts/v1 with retry). Error message made generic ('Could not determine which account to use — open a trade ticket on this page first, then try again.').
- manifest.json: lib/margin-warmup.js added to content_scripts (popup only loads constants.js — verified no other load sites).
- CLAUDE.md API section documents the cold-session 500 + warm-up.

Verification: node --check on all 8 modified files + manifest JSON parse; vm-based tests all pass — MarginWarmup module (8 checks: dedup, cooldowns, failure paths, probe listener), background handler (7 checks: ok response, one hidden tab, tab closed, probe polling, timing, cooldown, unknown-type rejection), positions.js integration (4 checks: 500→warm-up→retry recovery, cooldown reuse, retry count).

Note: could not live-test against a genuinely cold Fidelity session — the neo test browser's session was already warm by the time the root cause was identified, and its installed extension is the signed CRX, not a worktree load. Cold-session behavior is inferred from the live A/B probes (identical bodies: 500 cold / 200 warm, persisting across navigations).

Review round 2 (Copilot + CodeRabbit GitHub App on PR #387, 2026-11-09) — 7 inline findings, all verified real, fixed in f1c5770 and 45090da:

- Cooldowns lost on MV3 service-worker restart (no heartbeat from Optimize cash) → both warm-up timestamps persist to chrome.storage.session, restored once per worker lifetime (session storage clears when the browser closes, matching the server-side state's lifetime).
- Unbounded probe wait (fetch with no timeout could stall the polling loop past the 30 s deadline, leaving the tab open and warmInflight held) → probe fetch aborts after 8 s (AbortSignal.timeout), background caps each reply at 10 s via Promise.race; verified: never-replying probe still fails bounded at ~34.5 s with the tab closed.
- accounts/v1 fetch had no timeout → now fetchWithTimeout (POSITIONS_API timeout); timeouts classified retryable network errors.
- 200 text/html maintenance page parsed outside the retry loop → parsing moved inside; HTML classified retryable API_ERROR (warm-up + backoff apply).
- Storage write failure discarded a successfully fetched account → cache write now best effort.
- FAB looked dead during a cold-session account lookup → panel opens in loading state immediately, account resolved after.

All 7 threads replied and resolved (4 auto-resolved on push, 3 resolved manually). Harnesses extended: background 13 checks (incl. restart restore, unresponsive probe bound), account-resolve 11 checks (incl. HTML retry, cache-fail, timeout, session-expiry). PR #387 CLEAN/MERGEABLE on 45090da; watch stays armed for the bots' re-review of the new head.
<!-- SECTION:NOTES:END -->

## Comments

<!-- COMMENTS:BEGIN -->
created: 2026-11-09 15:13

---

Review round 1 (independent reviewer, 2026-11-09) found 2 critical + 1 risk, all verified real and fixed:

1. 🔴 content/main.js onMessage catch-all answered every unknown _fmc type with {error:'unhandled message type'} — including WARM_PROBE in the hidden warm-up tab, where the synchronous sendResponse preempted margin-warmup.js's async reply, so the probe could never succeed (every warm-up would burn the full 30s budget). Fixed: main.js now stays silent for types it doesn't own (FORCE_RECALC only). Also verified popup.js only ever sends FORCE_RECALC (tab-targeted), so nothing depends on the removed catch-all; the change also removes a pre-existing race where main.js could preempt the background's reply to popup-sent CACHE_GET etc.

2. 🔴 ChainCore is null outside option-chain/Trader+ pages (content/chain-core.js:8), so delegating mmf.js's pageAccount() to ChainCore.getAccount() was dead code on /portfolio/positions — the only page the FAB renders on. Fixed by extracting the account resolution chain into lib/account-resolve.js (page-agnostic: open ticket → last-used → accounts/v1 with retry + warm-up); chain-core.js now delegates to it, mmf.js uses it directly.

3. 🟡 Probe treated any 2xx as warm; Fidelity serves its maintenance page as 200 text/html and logged-out redirects land on 2xx HTML — a false positive would open a 5-min cooldown during which real 500s get no warm-up. Fixed: probe requires JSON content-type AND data.getAccountContext.acctDetails array.

Re-verification after fixes: node --check all 10 files; harnesses all green — margin-warmup module 11 checks (incl. strict probe: warm JSON true, maintenance HTML false, 500 false, bad JSON false), AccountResolve 8 checks (default tradable pick, persistence, storage precedence, ticket precedence, cold-500 → null), background handler 7 checks, positions integration 4 checks.

---
<!-- COMMENTS:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Committed as a771731 on branch t3/neo-browser-tabs ("fix: self-heal cold-session margin-calculator 500s; resolve Optimize cash account anywhere").

Changes: (1) FAB account fallback — mmf.js's pageAccount() delegates to the new page-agnostic lib/account-resolve.js (open ticket → last-used → accounts/v1 with retry), extracted from chain-core.js (null outside option-chain/Trader+ pages, so the original delegation idea was dead code on the positions page — caught in review). (2) Cold-session 500 recovery — on a retryable 5xx, positions.js/margin-api.js/chain-api.js/account-resolve.js await MarginWarmup.ensureWarm(); the background opens the margin-calculator page in a hidden tab, polls recovery via a page-context accounts/v1 probe (strict: JSON + acctDetails required, so the 200-HTML maintenance page can't fake success), closes the tab; deduped with cooldowns on both sides. (3) main.js's onMessage catch-all no longer answers _fmc types it doesn't own — it preempted other listeners' single sendResponse slot (would have broken the probe). CLAUDE.md documents the cold-session behavior.

Verification: 30 vm-based checks across four harnesses (MarginWarmup module incl. strict probe scenarios; AccountResolve fallback chain; background handler tab lifecycle; positions 500→warm→retry recovery), node --check on all 10 modified files, manifest JSON parse. Independent reviewer round found 2 critical + 1 risk; all verified real and fixed, harnesses extended accordingly.

Risks/follow-ups: cold-session recovery could not be exercised against a genuinely cold Fidelity session (the test browser was already warm and runs the signed CRX, not a worktree load); behavior rests on the live A/B probes from diagnosis plus the simulated tests. First real-world cold-session use should confirm a hidden margin-calculator tab briefly opens and the panel recovers within ~30 s.
<!-- SECTION:FINAL_SUMMARY:END -->
