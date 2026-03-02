import ccxt from 'ccxt';

// Exchanges that are CloudFront geo-blocked in the server's region.
// Any bot or demo simulator call to these will fail with a 403 before
// a connection can be established — surface a clear error immediately.
const GEO_BLOCKED_EXCHANGES = ['bybit', 'binance'];

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
    if (GEO_BLOCKED_EXCHANGES.includes(exchangeId)) {
      throw new Error(
        `Exchange "${exchangeAccount.exchange}" is geo-blocked in this region (CloudFront 403). ` +
        `Please switch this bot to OKX, KuCoin, Bitget, Gate.io, or MEXC.`
      );
    }

    const { apiKey, apiSecret, apiPassphrase } = exchangeAccount.getDecryptedKeys();
    const ExchangeClass = ccxt[exchangeId];
    if (!ExchangeClass) {
      throw new Error(`Exchange "${exchangeAccount.exchange}" is not supported by CCXT`);
    }

    const config = {
      apiKey,
      secret: apiSecret,
      enableRateLimit: true,
      timeout: 30_000,       // 30s timeout (default CCXT is 10s — too low for slow networks)
      options: { defaultType: 'spot' }
    };
    if (apiPassphrase) config.password = apiPassphrase;
    if (exchangeAccount.isSandbox) config.sandbox = true;

    const instance = new ExchangeClass(config);
    await instance.loadMarkets();
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
      // Clean up test instance
      this.pool.delete(`test:${exchangeAccount._id}`);

      return {
        isValid: true,
        canTrade: true,
        canWithdraw: false, // Conservative default - never assume withdraw
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
   * Used by DemoSimulator.
   * @param {string} exchangeName - CCXT exchange id
   * @returns {ccxt.Exchange}
   */
  getPublicInstance(exchangeName) {
    const id = exchangeName?.toLowerCase();
    if (GEO_BLOCKED_EXCHANGES.includes(id)) {
      throw new Error(
        `Exchange "${exchangeName}" is geo-blocked in this region. ` +
        `Use OKX, KuCoin, Bitget, Gate.io, or MEXC instead.`
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

  /**
   * Get list of all CCXT-supported exchange IDs
   */
  getSupportedExchanges() {
    return ccxt.exchanges;
  }

  /**
   * Get curated list of popular exchanges with metadata
   */
  getPopularExchanges() {
    return [
      { id: 'okx',     name: 'OKX',         supportsSpot: true, supportsFutures: true,  needsPassphrase: true  },
      { id: 'kucoin',  name: 'KuCoin',      supportsSpot: true, supportsFutures: true,  needsPassphrase: true  },
      { id: 'bitget',  name: 'Bitget',      supportsSpot: true, supportsFutures: true,  needsPassphrase: true  },
      { id: 'phemex',  name: 'Phemex',      supportsSpot: true, supportsFutures: true,  needsPassphrase: false },
      { id: 'gate',    name: 'Gate.io',     supportsSpot: true, supportsFutures: true,  needsPassphrase: false },
      { id: 'mexc',    name: 'MEXC',        supportsSpot: true, supportsFutures: true,  needsPassphrase: false },
      { id: 'huobi',   name: 'HTX (Huobi)', supportsSpot: true, supportsFutures: true,  needsPassphrase: false },
      { id: 'kraken',  name: 'Kraken',      supportsSpot: true, supportsFutures: false, needsPassphrase: false },
    ];
  }
}

// Export as singleton
export default new ExchangeConnector();
