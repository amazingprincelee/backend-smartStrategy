import ccxt from 'ccxt';

// Exchanges geo-blocked for PUBLIC (unauthenticated) data in the server's region.
// CloudFront blocks these on the public REST endpoints used by MarketDataService.
// Authenticated trading API endpoints are NOT blocked — user API-key bots can
// connect to Binance and Bybit normally for order placement.
const GEO_BLOCKED_PUBLIC = ['bybit', 'binance'];

// Exchange-specific CCXT options
const EXCHANGE_EXTRA_CONFIG = {
  binance: {
    options: {
      defaultType: 'spot',
      // Prevents clock-skew signature errors on Binance
      adjustForTimeDifference: true,
    },
  },
  bybit: {
    options: {
      // 'spot' for spot market; BotEngine overrides to 'linear' for futures
      defaultType: 'spot',
    },
  },
};

/**
 * ExchangeConnector - singleton CCXT connection pool.
 * Manages authenticated instances per user-exchange combination
 * and public instances for demo price feeds.
 */
class ExchangeConnector {
  constructor() {
    // Map: `${userId}:${exchangeAccountId}` => ccxt instance
    this.pool = new Map();
    // Map: exchangeName => public ccxt instance
    this.publicPool = new Map();
  }

  /**
   * Get or create an authenticated CCXT instance for a user's exchange account.
   * @param {Object} exchangeAccount - Mongoose ExchangeAccount document (must have select: +apiKeyEncrypted)
   * @returns {Promise<ccxt.Exchange>}
   */
  async getConnection(exchangeAccount) {
    const key = `${exchangeAccount.userId}:${exchangeAccount._id}`;
    if (this.pool.has(key)) {
      return this.pool.get(key);
    }
    return await this._createConnection(exchangeAccount, key);
  }

  async _createConnection(exchangeAccount, key) {
    const exchangeId = exchangeAccount.exchange?.toLowerCase();

    const { apiKey, apiSecret, apiPassphrase } = exchangeAccount.getDecryptedKeys();
    const ExchangeClass = ccxt[exchangeId];
    if (!ExchangeClass) {
      throw new Error(`Exchange "${exchangeAccount.exchange}" is not supported by CCXT`);
    }

    const extra = EXCHANGE_EXTRA_CONFIG[exchangeId] || {};
    const config = {
      apiKey,
      secret: apiSecret,
      enableRateLimit: true,
      timeout: 30_000,
      options: { defaultType: 'spot', ...(extra.options || {}) },
    };
    if (apiPassphrase) config.password = apiPassphrase;
    if (exchangeAccount.isSandbox) config.sandbox = true;

    const instance = new ExchangeClass(config);

    // loadMarkets() may fail for Bybit on geo-restricted servers (CloudFront blocks
    // the public /v5/market/instruments-info endpoint).
    // We warn but do NOT throw — CCXT can still route orders without the market catalog
    // as long as the caller passes the correct symbol format (which OrderManager does).
    try {
      await instance.loadMarkets();
    } catch (loadErr) {
      console.warn(
        `[ExchangeConnector] loadMarkets() failed for ${exchangeId} — ` +
        `may be geo-restricted on public data endpoints. Trading may still work. ` +
        `Error: ${loadErr.message}`
      );
    }

    this.pool.set(key, instance);
    return instance;
  }

  /**
   * Test an exchange account's API credentials.
   * @param {Object} exchangeAccount
   * @returns {Promise<{ isValid: boolean, canTrade: boolean, canWithdraw: boolean, error: string|null }>}
   */
  async testConnection(exchangeAccount) {
    try {
      const exchange = await this._createConnection(
        exchangeAccount,
        `test:${exchangeAccount._id}`
      );
      const balance = await exchange.fetchBalance();
      this.pool.delete(`test:${exchangeAccount._id}`);

      return {
        isValid: true,
        canTrade: true,
        canWithdraw: false,
        error: null,
        balanceSummary: Object.entries(balance.total || {})
          .filter(([, v]) => v > 0)
          .slice(0, 10)
          .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {})
      };
    } catch (err) {
      this.pool.delete(`test:${exchangeAccount._id}`);
      return {
        isValid: false,
        canTrade: false,
        canWithdraw: false,
        error: err.message
      };
    }
  }

  /**
   * Remove a connection from the pool (call when account is deleted or keys updated).
   */
  removeConnection(userId, exchangeAccountId) {
    const key = `${userId}:${exchangeAccountId}`;
    this.pool.delete(key);
  }

  /**
   * Get a public (unauthenticated) exchange instance for price feeds.
   * Used by DemoSimulator. Binance/Bybit public data is geo-blocked — use
   * MarketDataService (Gate.io → KuCoin fallback) for those instead.
   * @param {string} exchangeName - CCXT exchange id
   * @returns {ccxt.Exchange}
   */
  getPublicInstance(exchangeName) {
    const id = exchangeName?.toLowerCase();
    if (GEO_BLOCKED_PUBLIC.includes(id)) {
      console.warn(
        `[ExchangeConnector] Public price feed refused — "${exchangeName}" ` +
        `has geo-blocked public data endpoints. Using MarketDataService fallback.`
      );
      throw new Error(
        `Exchange "${exchangeName}" public data is geo-restricted. ` +
        `Use OKX, KuCoin, Bitget, Gate.io, or MEXC for price feeds.`
      );
    }
    if (this.publicPool.has(id)) {
      return this.publicPool.get(id);
    }
    const ExchangeClass = ccxt[id];
    if (!ExchangeClass) {
      throw new Error(`Exchange "${exchangeName}" is not supported by CCXT`);
    }
    const pubConfig = { enableRateLimit: true, timeout: 30_000 };
    const instance = new ExchangeClass(pubConfig);
    this.publicPool.set(id, instance);
    return instance;
  }

  getSupportedExchanges() {
    return ccxt.exchanges;
  }

  /**
   * Curated list of popular exchanges — shown in Settings and CreateBot.
   */
  getPopularExchanges() {
    return [
      { id: 'binance', name: 'Binance',     supportsSpot: true, supportsFutures: true,  needsPassphrase: false },
      { id: 'bybit',   name: 'Bybit',       supportsSpot: true, supportsFutures: true,  needsPassphrase: false },
      { id: 'okx',     name: 'OKX',         supportsSpot: true, supportsFutures: true,  needsPassphrase: true  },
      { id: 'kucoin',  name: 'KuCoin',      supportsSpot: true, supportsFutures: true,  needsPassphrase: true  },
      { id: 'bitget',  name: 'Bitget',      supportsSpot: true, supportsFutures: true,  needsPassphrase: true  },
      { id: 'gate',    name: 'Gate.io',     supportsSpot: true, supportsFutures: true,  needsPassphrase: false },
      { id: 'mexc',    name: 'MEXC',        supportsSpot: true, supportsFutures: true,  needsPassphrase: false },
      { id: 'phemex',  name: 'Phemex',      supportsSpot: true, supportsFutures: true,  needsPassphrase: false },
      { id: 'huobi',   name: 'HTX (Huobi)', supportsSpot: true, supportsFutures: true,  needsPassphrase: false },
      { id: 'kraken',  name: 'Kraken',      supportsSpot: true, supportsFutures: false, needsPassphrase: false },
    ];
  }
}

export default new ExchangeConnector();
