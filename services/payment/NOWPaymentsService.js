/**
 * NOWPayments service.
 * Docs: https://documenter.getpostman.com/view/7907941/2s93JusNJt
 *
 * Env vars required:
 *   NOWPAYMENTS_API_KEY        — your NOWPayments API key
 *   NOWPAYMENTS_IPN_SECRET     — IPN secret for webhook verification
 */

import crypto from 'crypto';
import { getPaymentKeys } from './paymentKeys.js';

const BASE_URL = 'https://api.nowpayments.io/v1';

class NOWPaymentsService {
  async _request(method, path, body = null) {
    const { nowpaymentsApiKey } = await getPaymentKeys();
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key':    nowpaymentsApiKey,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || `NOWPayments error ${res.status}`);
    return data;
  }

  /**
   * Create a payment invoice.
   * Returns { chargeId, paymentUrl }
   */
  async createCharge({ userId, userEmail, amountUSD, description }) {
    const invoice = await this._request('POST', '/invoice', {
      price_amount:    amountUSD,
      price_currency:  'usd',
      order_id:        `user-${userId}-${Date.now()}`,
      order_description: description || 'SmartStrategy Premium — $29/month',
      ipn_callback_url:  `${process.env.SERVER_URL || 'http://localhost:5000'}/api/payments/webhook/nowpayments`,
      success_url:       `${process.env.CLIENT_URL}/payment/success`,
      cancel_url:        `${process.env.CLIENT_URL}/pricing`,
      is_fixed_rate:     true,
      is_fee_paid_by_user: false,
      // Store metadata in order_id won't work — use custom field
      customer_email: userEmail,
    });

    // NOWPayments invoice gives an id — store userId in order description for webhook recovery
    return {
      chargeId:   String(invoice.id),
      paymentUrl: invoice.invoice_url,
      // store order_id so we can match it back: `user-${userId}-timestamp`
      orderId:    invoice.order_id,
    };
  }

  /**
   * Verify IPN webhook (HMAC-SHA512).
   */
  async verifyWebhook(rawBody, signatureHeader) {
    const { nowpaymentsIpnSecret } = await getPaymentKeys();
    if (!nowpaymentsIpnSecret) throw new Error('IPN secret not configured');
    const sig = crypto
      .createHmac('sha512', nowpaymentsIpnSecret)
      .update(rawBody, 'utf8')
      .digest('hex');
    if (sig !== signatureHeader) throw new Error('Invalid NOWPayments IPN signature');

    const payload   = JSON.parse(rawBody);
    const orderId   = payload.order_id || '';  // 'user-<userId>-<ts>'
    const userId    = orderId.split('-')[1] || null;

    return {
      event:     payload.payment_status,    // 'finished' = confirmed
      chargeId:  String(payload.id),
      userId,
      email:     payload.customer_email || null,
      status:    payload.payment_status,
    };
  }
}

export default new NOWPaymentsService();
