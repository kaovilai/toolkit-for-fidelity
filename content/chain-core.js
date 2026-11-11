// ChainCore — shared plumbing for the option-chain features (content/chain.js hover hints and
// content/roll.js roll assistant): settings, page context, account, baseline (positions +
// current balance), and rate-limited margin calculations. `null` outside the option chain page.
'use strict';
const ChainCore = (() => {
  // The standalone option chain page and Fidelity Trader+ Web (its dashboard embeds the same chain).
  const ON_CHAIN_PAGE = location.pathname.includes('/option-chain') || location.pathname.includes('/traderplus');
  if (!ON_CHAIN_PAGE) return null;

  const log = makeDebugLog('[FMC-CORE]');
  const { STORAGE_KEY_SETTINGS, CHAIN_LIMITS, ERROR_TYPES } = FMC_CONSTANTS;
  const { PRICELIST: BASE_TTL_MS } = FMC_CONSTANTS.CACHE_TTL_MS;

  // Mutated in place (never replaced) so modules can hold the reference.
  const settings = { ...FMC_CONSTANTS.DEFAULT_SETTINGS };
  const settingsListeners = [];
  const baseListeners = [];
  let base = null;
  let basePromise = null;

  const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const fmt = (n) => (Number.isFinite(n) ? currency.format(n) : '--');
  const clampNum = (raw, min, max, fallback) => {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };

  // --- Settings ---
  function normalize() {
    settings.chainQty = Math.round(clampNum(settings.chainQty, 1, CHAIN_LIMITS.QTY_MAX, 1));
    settings.minWithdrawable = clampNum(settings.minWithdrawable, 0, CHAIN_LIMITS.MIN_WITHDRAWABLE_MAX, 0);
    settings.borrowRate = clampNum(settings.borrowRate, 0, CHAIN_LIMITS.BORROW_RATE_MAX, 4.88);
  }

  async function loadSettings() {
    try {
      const result = await chrome.storage.sync.get(STORAGE_KEY_SETTINGS);
      const loaded = result[STORAGE_KEY_SETTINGS];
      if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) Object.assign(settings, loaded);
    } catch (err) {
      log('could not load settings:', err.message);
    }
    normalize();
    chrome.storage.onChanged.addListener((changes, area) => {
      const next = changes[STORAGE_KEY_SETTINGS]?.newValue;
      if (area !== 'sync' || !next || typeof next !== 'object') return;
      const prev = { ...settings };
      Object.assign(settings, next);
      normalize();
      for (const cb of settingsListeners) cb(settings, prev);
    });
  }

  /** Registers `cb(settings, previousSettings)` for settings changes made in the popup. */
  function onSettings(cb) { settingsListeners.push(cb); }

  // --- Page context ---
  /** Underlying ticker for the chain currently shown (symbol box, falling back to the URL). */
  function getUnderlying() {
    // Trader+ Web: the active symbol is shown in the quote panel (`.symbol-info .code`) and chart title.
    const tp = (document.querySelector('.symbol-info .code, cq-symbol')?.textContent ?? '').trim().toUpperCase();
    if (location.pathname.includes('/traderplus') && /^[A-Z0-9.]{1,10}$/.test(tp)) return tp;
    const box = document.querySelector('[role="combobox"][aria-label="SYMBOL"], input[aria-label="SYMBOL"]');
    const fromBox = (box?.value ?? box?.textContent ?? '').trim().toUpperCase();
    const fromUrl = new URLSearchParams(location.search).get('symbol')?.trim().toUpperCase();
    return /^[A-Z0-9.]{1,10}$/.test(fromBox) ? fromBox : (fromUrl || null);
  }

  /**
   * Account number via the shared page-agnostic resolver (lib/account-resolve.js): the open
   * trade ticket, the last-used account, then Fidelity's default tradable account.
   * @returns {Promise<string|null>}
   */
  function getAccount() { return AccountResolve.getAccount(); }

  // --- Baseline (current positions + balance) ---
  function readBalance(baselineData) {
    const b = baselineData?.data?.getTradeCalculator?.marginCalcResp?.balance;
    if (!b) return null;
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    return { credit: num(b.marginCreditDebit), house: num(b.houseBalance), avl: num(b.avlToTradeWithoutMarginImpact) };
  }

  /** The cached baseline, or null if none has been fetched yet. */
  function peekBase() { return base; }

  /** Registers `cb()` to run whenever a fresh baseline replaces the old one (derived data is stale). */
  function onNewBase(cb) { baseListeners.push(cb); }

  /**
   * Fetches (or returns the cached) baseline for `account`: price list, current balance, and
   * signed holdings by symbol — all from one current-status call.
   * @param {string} account
   * @returns {Promise<{account: string, priceList: Array, baselineData: Object, holdings: Object,
   *   bal: {credit: number, house: number, avl: number}, ts: number}>}
   */
  async function ensureBase(account) {
    if (base && base.account === account && Date.now() - base.ts < BASE_TTL_MS) return base;
    if (basePromise) return basePromise;
    basePromise = (async () => {
      const { priceList, baselineData, holdings } = await PositionsAPI.fetchStatus(account);
      const bal = readBalance(baselineData);
      if (!priceList.length || !bal) {
        throw Object.assign(new Error('No positions or balance found for this account'), { type: ERROR_TYPES.CLIENT_ERROR });
      }
      base = { account, priceList, baselineData, holdings: holdings ?? {}, bal, ts: Date.now() };
      for (const cb of baseListeners) cb();
      return base;
    })().finally(() => { basePromise = null; });
    return basePromise;
  }

  /**
   * Runs one rate-limited trade-calculator request for `orders` against the cached baseline.
   * @param {string} account
   * @param {Array<Object>} orders
   * @returns {Promise<Object>} MarginCalc impact (projected credit, house balance, withdrawable
   *   cash and their changes from the current balance).
   */
  async function calculate(account, orders) {
    const b = await ensureBase(account);
    // A newer request displaces a waiting one; abandon it instead of sending without a token.
    const slot = await RateLimiter.acquire();
    if (slot.cancelled) throw Object.assign(new Error('superseded by a newer request'), { cancelled: true });
    const projected = await MarginAPI.fetchMarginCalc(account, orders, () => {}, b.priceList);
    const impact = MarginCalc.computeImpact(projected, b.baselineData, orders);
    if (!impact) throw new Error('No balance in margin response');
    return impact;
  }

  return { settings, loadSettings, onSettings, getUnderlying, getAccount, ensureBase, peekBase, onNewBase, calculate, fmt, clampNum, log };
})();
