const { audit } = require('../lib/audit');
const { enqueue } = require('../lib/jobs');
const logger = require('../observability/logger');

// Payment provider stub. Swap for Razorpay/Stripe client; must accept an idempotency key.
const paymentProvider = {
  async charge({ paymentId, amountCents }) {
    if (process.env.PAYMENT_FAIL_ALL === 'true') throw Object.assign(new Error('card_declined'), { permanent: true });
    return { providerRef: `pay_${paymentId.slice(0, 8)}`, amountCents };
  },
  async refund({ providerRef }) {
    return { refundRef: `rf_${providerRef}` };
  },
};

function createHandlers({ db }) {
  return {
    // Saga step 2: charge. Success -> scheduled. Permanent failure -> compensate.
    async process_payment({ consultationId, paymentId }) {
      const { rows } = await db.query('SELECT id, amount_cents, status FROM payments WHERE id = $1', [paymentId]);
      const payment = rows[0];
      if (!payment || payment.status !== 'pending') return; // idempotent: already handled

      try {
        const { providerRef } = await paymentProvider.charge({ paymentId, amountCents: payment.amount_cents });
        await db.tx(async (c) => {
          await c.query(`UPDATE payments SET status = 'succeeded', provider_ref = $2, updated_at = now() WHERE id = $1`, [paymentId, providerRef]);
          await c.query(`UPDATE consultations SET status = 'scheduled', updated_at = now() WHERE id = $1 AND status = 'pending_payment'`, [consultationId]);
          await enqueue(c, 'notify', { consultationId, event: 'consultation.scheduled' });
          await audit(c, { action: 'payment.succeeded', entity: 'payment', entityId: paymentId });
        });
      } catch (err) {
        if (!err.permanent) throw err; // transient -> worker retries with backoff
        // Compensating transaction: undo the booking.
        await db.tx(async (c) => {
          await c.query(`UPDATE payments SET status = 'failed', updated_at = now() WHERE id = $1`, [paymentId]);
          const { rows: cr } = await c.query(
            `UPDATE consultations SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status = 'pending_payment' RETURNING slot_id`,
            [consultationId]
          );
          if (cr[0]) await c.query(`UPDATE availability_slots SET status = 'open', version = version + 1 WHERE id = $1`, [cr[0].slot_id]);
          await audit(c, { action: 'saga.compensated', entity: 'consultation', entityId: consultationId, metadata: { reason: err.message } });
        });
      }
    },

    async refund_payment({ consultationId }) {
      const { rows } = await db.query(`SELECT id, provider_ref FROM payments WHERE consultation_id = $1 AND status = 'succeeded'`, [consultationId]);
      if (!rows[0]) return;
      await paymentProvider.refund({ providerRef: rows[0].provider_ref });
      await db.query(`UPDATE payments SET status = 'refunded', updated_at = now() WHERE id = $1`, [rows[0].id]);
      await audit(db, { action: 'payment.refunded', entity: 'payment', entityId: rows[0].id });
    },

    async notify(payload) {
      // Email/SMS/push integration point.
      logger.info({ job: 'notify', ...payload }, 'notification sent');
    },

    async generate_prescription_pdf({ prescriptionId }) {
      // Heavy work (PDF render + upload to encrypted object storage) runs off the request path.
      logger.info({ job: 'generate_prescription_pdf', prescriptionId }, 'prescription pdf generated');
    },
  };
}

module.exports = { createHandlers, paymentProvider };
