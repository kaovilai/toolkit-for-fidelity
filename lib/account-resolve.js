// AccountResolve — account-number resolution for any Fidelity page: the open trade ticket,
// the account last used by the trade-ticket panel, the account remembered for chain hints,
// then Fidelity's default tradable account via accounts/v1 (with retry/backoff and the
// cold-session warm-up). Extracted from content/chain-core.js — which is null outside the
// option-chain/Trader+ pages — so page-gated modules (e.g. content/mmf.js on the positions
// page) can use the same resolution chain.
'use strict';
const AccountResolve = (() => {
  const log = makeDebugLog('[FMC-ACCT]');
  const { STORAGE_KEY_STATUS, STORAGE_KEY_CHAIN_ACCOUNT, ERROR_TYPES } = FMC_CONSTANTS;

  /**
   * Asks Fidelity for the account list (same call the margin calculator page makes) and picks
   * the default tradable brokerage account, else the first tradable one.
   * @returns {Promise<string|null>}
   */
  async function fetchDefaultAccount() {
    const retryable = new Set(FMC_CONSTANTS.RETRYABLE_ERROR_TYPES);
    // Retry transient failures (5xx/408/429/network) with exponential backoff, like every other Fidelity call.
    const resp = await Retry.withBackoff(async () => {
      let r;
      try {
        r = await fetch(FMC_CONSTANTS.API.ACCOUNTS_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: '*/*' },
          credentials: 'include',
          body: JSON.stringify({
            acctCategory: 'Brokerage',
            filters: { returnAcctTradeAttrDetail: true, returnPreferenceDetail: true }
          })
        });
      } catch (e) {
        throw Object.assign(new Error(e.message), { type: ERROR_TYPES.NETWORK_ERROR });
      }
      if (!isSessionExpiredResponse(r) && isRetryableHttpStatus(r.status)) {
        // A 5xx on a cold session means Fidelity's backend lacks the state its own
        // margin-calculator page creates — warm it up (hidden tab) before the retry.
        if (r.status >= 500) await MarginWarmup.ensureWarm();
        const retryAfterMs = parseRetryAfterMs(r.headers.get('Retry-After'), FMC_CONSTANTS.MAX_RETRY_AFTER_MS);
        throw Object.assign(new Error(`HTTP ${r.status}`), { type: ERROR_TYPES.API_ERROR, retryAfterMs });
      }
      return r;
    }, retryable).catch(err => (retryable.has(err?.type) ? null : Promise.reject(err)));
    if (!resp) return null;
    if (isSessionExpiredResponse(resp)) throw Object.assign(new Error('Session expired'), { type: ERROR_TYPES.SESSION_EXPIRED });
    if (!resp.ok) return null;
    const list = (await resp.json())?.data?.getAccountContext?.acctDetails;
    if (!Array.isArray(list)) return null;
    const usable = list.filter(a => a.acctNum && a.acctSubType === 'Brokerage' && a.acctTradeAttrDetail?.isTradable && !a.preferenceDetail?.isHidden);
    return (usable.find(a => a.preferenceDetail?.isDefaultAcct) ?? usable[0])?.acctNum ?? null;
  }

  /**
   * Account number, in order of preference: the open trade ticket, the account last used by the
   * trade-ticket panel, the account remembered for chain hints, then Fidelity's default account.
   * @returns {Promise<string|null>}
   */
  async function getAccount() {
    const ticket = document.querySelector('ott-account-dropdown, #trade-container-shell')?.textContent ?? '';
    const m = /\(([A-Z]?\d{8,9})\)/.exec(ticket);
    if (m) return m[1];
    try {
      const r = await chrome.storage.local.get([STORAGE_KEY_STATUS, STORAGE_KEY_CHAIN_ACCOUNT]);
      const known = r[STORAGE_KEY_STATUS]?.accountNum ?? r[STORAGE_KEY_CHAIN_ACCOUNT];
      if (known) return known;
      const fetched = await fetchDefaultAccount();
      if (fetched) await chrome.storage.local.set({ [STORAGE_KEY_CHAIN_ACCOUNT]: fetched });
      return fetched;
    } catch (err) {
      if (err?.type === ERROR_TYPES.SESSION_EXPIRED) throw err;
      log('account lookup failed:', err);
      return null;
    }
  }

  return { getAccount, fetchDefaultAccount };
})();
