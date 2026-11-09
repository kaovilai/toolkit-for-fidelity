// MarginWarmup — recovers from Fidelity's cold-session margin-calculator 500s.
//
// Until the margin calculator page (/ftgw/digital/margin-calculator/) has been loaded once
// in a browsing session, every api-margin-calculator endpoint (current-status, accounts,
// trade-calculator, option chain) answers 500 "Unknown System Exception": the page's load
// sequence creates server-side state the API depends on, and direct API calls made first
// fail regardless of headers or request shape (verified against Fidelity's own page, whose
// identical requests succeed). Content scripts that hit a retryable 5xx call ensureWarm(),
// which asks the background worker to open the page in a hidden tab and confirm recovery;
// the existing Retry.withBackoff loop then retries against a warm backend.
//
// This module runs only in content scripts. The other half — the WARM_MARGIN_CALC message
// handler that drives the hidden tab — lives in background.js.
'use strict';
const MarginWarmup = (() => {
  // How long a successful warm-up is trusted. The server-side state lasts for the rest of
  // the browsing session, so this only stops redundant tab opens after a confirmed success;
  // a fresh page load (new content-script world) re-asks and gets the background's answer
  // from its own cooldown bookkeeping.
  const COOLDOWN_MS = 5 * 60 * 1000;
  // Hard cap on waiting for the background's answer, matching the background's own warm-up
  // budget (tab load + probe polling). On timeout the caller proceeds to its normal retry
  // path — a late success is still picked up by the next attempt.
  const ASK_TIMEOUT_MS = 35 * 1000;
  // Bound on the probe's own fetch: a stalled accounts/v1 must not hold the background's
  // polling loop (and the hidden tab) open past its budget. AbortSignal.timeout fires as an
  // AbortError, which the .catch below reports as ok:false.
  const PROBE_FETCH_TIMEOUT_MS = 8 * 1000;
  // accounts/v1 with the same filters chain-core's fetchDefaultAccount sends — the lightest
  // call that fails with 500 on a cold session and succeeds once warmed.
  const PROBE_BODY = JSON.stringify({ acctCategory: 'Brokerage', filters: { returnAcctTradeAttrDetail: true, returnPreferenceDetail: true } });

  let inflight = null; // one warm-up request per page, shared by all failing calls
  let lastOk = 0;

  /** Sends the warm-up request; resolves true only when the background confirms recovery. */
  function askBackground() {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
      const timer = setTimeout(() => done(false), ASK_TIMEOUT_MS);
      try {
        chrome.runtime.sendMessage({ type: FMC_CONSTANTS.MESSAGE_TYPES.WARM_MARGIN_CALC, _fmc: true }, (resp) => {
          clearTimeout(timer);
          done(!chrome.runtime.lastError && !!resp?.ok);
        });
      } catch {
        clearTimeout(timer);
        done(false);
      }
    });
  }

  /**
   * Requests a margin-calculator warm-up and resolves once the backend has recovered (or
   * the attempt gave up). Safe to call from every failing request: concurrent calls share
   * one in-flight request, and a recent success is answered immediately without asking.
   * Never rejects — a failed warm-up leaves the caller's normal retry/error path intact.
   * @returns {Promise<boolean>} true when the backend answered ok.
   */
  async function ensureWarm() {
    if (Date.now() - lastOk < COOLDOWN_MS) return true;
    if (!inflight) {
      inflight = askBackground().finally(() => { inflight = null; });
    }
    const ok = await inflight.catch(() => false);
    if (ok) lastOk = Date.now();
    return ok;
  }

  // The background worker cannot call the margin-calculator API itself (its requests carry
  // the extension origin, which Fidelity rejects), so it probes recovery through this tab:
  // the WARM_PROBE listener runs the accounts/v1 check in page context, where the request
  // is same-origin with the user's cookies. Only the hidden warm-up tab ever receives this
  // message (tabs.sendMessage targets one tab).
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?._fmc && msg.type === FMC_CONSTANTS.MESSAGE_TYPES.WARM_PROBE) {
      fetch(FMC_CONSTANTS.API.ACCOUNTS_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: '*/*' },
        credentials: 'include',
        body: PROBE_BODY,
        signal: AbortSignal.timeout(PROBE_FETCH_TIMEOUT_MS)
      })
        .then(async (resp) => {
          // A bare resp.ok is not enough: Fidelity serves its maintenance page (and a
          // logged-out redirect) as 2xx HTML. Require a JSON body with the expected
          // account list before declaring the backend warm — a false positive would open a
          // 5-minute cooldown during which real 500s get no warm-up at all.
          if (!resp.ok || !/json/i.test(resp.headers.get('content-type') ?? '')) return sendResponse({ ok: false });
          const data = await resp.json().catch(() => null);
          sendResponse({ ok: Array.isArray(data?.data?.getAccountContext?.acctDetails) });
        })
        .catch(() => sendResponse({ ok: false }));
      return true; // keep the message channel open for the async response
    }
    return false;
  });

  return { ensureWarm };
})();
