/**
 * Coinbase Commerce payment service.
 * Docs: https://docs.cloud.coinbase.com/commerce/reference
 *
 * Env vars required:
 *   COINBASE_COMMERCE_API_KEY   — your Commerce API key
 *   COINBASE_COMMERCE_WEBHOOK_SECRET — webhook shared secret
 */

import crypto from 'crypto';
import { getPaymentKeys } from './paymentKeys.js';

const BASE_URL = 'https://api.commerce.coinbase.com';

class CoinbaseCommerceService {
  async _request(method, path, body = null) {
    const { coinbaseApiKey } = await getPaymentKeys();
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type':    'application/json',
        'X-CC-Api-Key':    coinbaseApiKey,
        'X-CC-Version':    '2018-03-22',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `Coinbase Commerce error ${res.status}`);
    return data;
  }

  /**
   * Create a one-time charge for $29 premium subscription.
   * Returns { chargeId, chargeCode, paymentUrl }
   */
  async createCharge({ userId, userEmail, amountUSD, description, metadata = {} }) {
    const charge = await this._request('POST', '/charges', {
      name:        'SmartStrategy Premium',
      description: description || 'Monthly Premium Subscription — $29/month',
      pricing_type: 'fixed_price',
      local_price:  { amount: String(amountUSD), currency: 'USD' },
      metadata:     { userId: String(userId), email: userEmail, ...metadata },
      redirect_url:  `${process.env.CLIENT_URL}/payment/success`,
      cancel_url:    `${process.env.CLIENT_URL}/pricing`,
    });

    return {
      chargeId:   charge.data.id,
      chargeCode: charge.data.code,
      paymentUrl: charge.data.hosted_url,
    };
  }

  /**
   * Verify webhook signature and return the event type + charge data.
   * Returns { event, chargeId, userId, status } or throws if invalid.
   */
  async verifyWebhook(rawBody, signatureHeader) {
    const { coinbaseWebhookSecret } = await getPaymentKeys();
    if (!coinbaseWebhookSecret) throw new Error('Webhook secret not configured');

    const sig = crypto
      .createHmac('sha256', coinbaseWebhookSecret)
      .update(rawBody, 'utf8')
      .digest('hex');

    if (sig !== signatureHeader) throw new Error('Invalid Coinbase Commerce webhook signature');

    const payload = JSON.parse(rawBody);
    const event   = payload.event?.type;           // e.g. 'charge:confirmed'
    const charge  = payload.event?.data;

    return {
      event,
      chargeId:  charge?.id,
      chargeCode: charge?.code,
      userId:    charge?.metadata?.userId,
      email:     charge?.metadata?.email,
      status:    charge?.timeline?.[charge.timeline.length - 1]?.status || null,
    };
  }
}

export default new CoinbaseCommerceService();
