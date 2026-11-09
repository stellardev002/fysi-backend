import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Pool } from 'pg';
import { chain } from './fake-chain.js';
import {
  api,
  approvedVendor,
  createPool,
  createProduct,
  createTestApp,
  mailbox,
  PASSWORD,
  registerAdmin,
  registerCustomer,
  sentSubjects,
  type Session,
  setupPayments,
  tick,
} from './helpers.js';

const ADDRESS = {
  recipientName: 'Grace Ajayi',
  phone: '+2348031234567',
  line1: '14 Bourdillon Road',
  city: 'Ikoyi',
  state: 'Lagos',
};

describe('Payments on Stellar (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;
  let call: ReturnType<typeof api>;
  let admin: Session;
  let founding: Session & { slug: string };
  let regular: Session & { slug: string };
  let settlement: string;
  let tote: { id: string }; // founding vendor, $12.50
  let jar: { id: string }; // regular vendor, $20.00

  beforeAll(async () => {
    app = await createTestApp();
    pool = createPool();
    call = api(app);
    settlement = (await setupPayments(app)).publicKey;
    admin = await registerAdmin(app, pool);
    founding = await approvedVendor(app, admin, { founding: true });
    regular = await approvedVendor(app, admin);
    tote = await createProduct(app, founding, { priceCents: 1250, stock: 50 });
    jar = await createProduct(app, regular, { title: 'Glass storage jar', priceCents: 2000, stock: 50 });
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  /** A customer with the two products in the cart, checked out. */
  async function checkout(quantities: [number, number] = [2, 1]) {
    const customer = await registerCustomer(app);
    await call('put', `/api/v1/cart/items/${tote.id}`, customer.accessToken).send({ quantity: quantities[0] }).expect(200);
    if (quantities[1] > 0)
      await call('put', `/api/v1/cart/items/${jar.id}`, customer.accessToken).send({ quantity: quantities[1] }).expect(200);
    const res = await call('post', '/api/v1/checkout', customer.accessToken)
      .send({ deliveryAddress: ADDRESS })
      .expect(201);
    return { customer, order: res.body.data };
  }

  const getOrder = async (s: Session, id: string) =>
    (await call('get', `/api/v1/orders/${id}`, s.accessToken).expect(200)).body.data;

  it('opens a sponsored custodial wallet for every approved vendor (V4)', async () => {
    const res = await call('get', '/api/v1/vendor/wallet', regular.accessToken).expect(200);
    expect(res.body.data).toMatchObject({ status: 'active', available: { cents: 0 }, pending: { cents: 0 } });
    // On chain: no XLM of its own (reserves sponsored), a USDC trustline.
    const account = chain.accounts.get(res.body.data.address)!;
    expect(account.lines.get('XLM')).toBe(0n);
    expect(chain.usdc(res.body.data.address)).toBe('0');
  });

  it('checks out a multi-vendor cart with every payment method ready (C5–C6)', async () => {
    const { order } = await checkout();
    expect(order).toMatchObject({
      status: 'awaiting_payment',
      total: { cents: 2 * 1250 + 2000, usd: '45.00' },
      paid: '0',
      deliveryAddress: { city: 'Ikoyi', state: 'Lagos' },
    });
    expect(order.vendorOrders).toHaveLength(2);
    const p = order.payment;
    expect(p).toMatchObject({ destination: settlement, assetCode: 'USDC', memo: order.number, amountDue: '45' });
    expect(p.memo).toMatch(/^FY[A-Z2-9]{10}$/);
    expect(new URL(p.sep7Uri).searchParams.get('memo')).toBe(order.number);
    expect(p.payLink).toMatch(/^https:\/\/fysi\.test\/pay\//);

    const page = await call('get', `/api/v1/pay/${p.payLink.split('/pay/')[1]}`).expect(200);
    expect(page.body.data).toMatchObject({ number: order.number, status: 'awaiting_payment' });
    expect(JSON.stringify(page.body.data)).not.toContain('Bourdillon');

    // Stock is held while the order waits for payment.
    const product = await call('get', `/api/v1/vendor/products/${tote.id}`, founding.accessToken).expect(200);
    expect(product.body.data.stock).toBeLessThanOrEqual(48);
  });

  it('confirms a QR / link payment, including an underpayment topped up (rules 2–3)', async () => {
    const { customer, order } = await checkout();
    const wallet = chain.externalWallet('100');
    expect(chain.pay(wallet, { destination: settlement, amount: '30', memo: order.number }).kind).toBe('success');
    await tick(app);
    let fresh = await getOrder(customer, order.id);
    expect(fresh).toMatchObject({ status: 'awaiting_payment', paid: '30', payment: { amountDue: '15' } });

    chain.pay(wallet, { destination: settlement, amount: '15', memo: order.number });
    await tick(app);
    fresh = await getOrder(customer, order.id);
    expect(fresh.status).toBe('paid');
    expect(fresh.payment).toBeNull();
    expect(fresh.transactions).toHaveLength(2);
    expect(fresh.transactions[0].explorerUrl).toMatch(/stellar\.expert\/explorer\/testnet\/tx\//);
    expect(fresh.vendorOrders.map((v: { status: string }) => v.status)).toEqual(['paid', 'paid']);

    // C7 and V9 emails; the cart no longer holds what was bought.
    expect(sentSubjects.get(customer.email)?.at(-1)).toMatch(/is paid/);
    expect(sentSubjects.get(regular.email)?.some((s) => s.includes(order.number))).toBe(true);
    const cart = await call('get', '/api/v1/cart', customer.accessToken).expect(200);
    expect(cart.body.data.items).toEqual([]);

    // The regular vendor sees it in pending (escrow) at 5% commission; the founding vendor pays none.
    const vendorOrders = await call('get', '/api/v1/vendor/orders', regular.accessToken).expect(200);
    const mine = vendorOrders.body.data.result.find((v: { orderNumber: string }) => v.orderNumber === order.number);
    expect(mine).toMatchObject({ commissionBps: 500, commission: { cents: 100 }, payout: { cents: 1900 }, escrowStatus: 'held' });
    const foundingOrders = await call('get', '/api/v1/vendor/orders', founding.accessToken).expect(200);
    expect(
      foundingOrders.body.data.result.find((v: { orderNumber: string }) => v.orderNumber === order.number),
    ).toMatchObject({ commissionBps: 0, payout: { cents: 2500 } });
  });

  it('pays from an external wallet the API prepared (connect wallet)', async () => {
    const { customer, order } = await checkout([1, 0]);
    const wallet = chain.externalWallet('50');
    const prepared = await call('post', `/api/v1/orders/${order.id}/pay/external`, customer.accessToken)
      .send({ sourceAddress: wallet.publicKey() })
      .expect(200);
    expect(prepared.body.data.amount).toBe('12.5');
    const tx = TransactionBuilder.fromXDR(prepared.body.data.transaction, Networks.TESTNET);

    // A changed transaction is refused.
    const other = chain.externalWallet('50');
    const forged = await call('post', `/api/v1/orders/${order.id}/pay/external`, customer.accessToken)
      .send({ sourceAddress: other.publicKey() })
      .expect(200);
    await call('post', `/api/v1/orders/${order.id}/pay/external/submit`, customer.accessToken)
      .send({ signedTransaction: forged.body.data.transaction })
      .expect(400);

    tx.sign(wallet);
    const paid = await call('post', `/api/v1/orders/${order.id}/pay/external/submit`, customer.accessToken)
      .send({ signedTransaction: tx.toEnvelope().toXDR('base64') })
      .expect(200);
    expect(paid.body.data.status).toBe('paid');
    expect(chain.usdc(wallet.publicKey())).toBe('37.5');
  });

  it('pays with a Fysi wallet and PIN; the platform pays the fee (C9)', async () => {
    const { customer, order } = await checkout([1, 0]);
    await call('post', '/api/v1/wallet', customer.accessToken).send({ pin: '482913' }).expect(400);
    await call('patch', '/api/v1/auth/me', customer.accessToken).send({ phone: '+2348031230000' }).expect(200);
    const created = await call('post', '/api/v1/wallet', customer.accessToken).send({ pin: '482913' }).expect(201);
    expect(created.body.data).toMatchObject({ status: 'active', balance: '0', kycTier: 1, balanceCap: { cents: 20000 } });
    expect(created.body.data.depositUri).toContain(created.body.data.address);

    await call('post', `/api/v1/orders/${order.id}/pay/wallet`, customer.accessToken).send({ pin: '482913' }).expect(409);
    chain.credit(created.body.data.address, '20');
    await call('post', `/api/v1/orders/${order.id}/pay/wallet`, customer.accessToken).send({ pin: '000000' }).expect(403);
    const paid = await call('post', `/api/v1/orders/${order.id}/pay/wallet`, customer.accessToken)
      .send({ pin: '482913' })
      .expect(200);
    expect(paid.body.data.status).toBe('paid');

    const wallet = await call('get', '/api/v1/wallet', customer.accessToken).expect(200);
    expect(wallet.body.data.balance).toBe('7.5');
    expect(wallet.body.data.activity[0]).toMatchObject({ direction: 'out', amount: '12.5', memo: order.number });
    // Fee-bumped by the platform: the customer wallet still holds no XLM.
    expect(chain.accounts.get(created.body.data.address)!.lines.get('XLM')).toBe(0n);
  });

  it('ships, confirms delivery and pays the vendor out (V8, C8, payout rule 4)', async () => {
    const { customer, order } = await checkout([1, 1]);
    const wallet = chain.externalWallet('100');
    chain.pay(wallet, { destination: settlement, amount: '32.5', memo: order.number });
    await tick(app);
    const vo = (await getOrder(customer, order.id)).vendorOrders.find(
      (v: { vendorSlug: string }) => v.vendorSlug === regular.slug,
    );

    await call('patch', `/api/v1/vendor/orders/${vo.id}/status`, regular.accessToken).send({ status: 'delivered' }).expect(409);
    await call('patch', `/api/v1/vendor/orders/${vo.id}/status`, regular.accessToken).send({ status: 'shipped' }).expect(400);
    await call('patch', `/api/v1/vendor/orders/${vo.id}/status`, regular.accessToken).send({ status: 'processing' }).expect(200);
    const shipped = await call('patch', `/api/v1/vendor/orders/${vo.id}/status`, regular.accessToken)
      .send({ status: 'shipped', carrier: 'GIG Logistics', trackingNumber: 'GIG-4471' })
      .expect(200);
    expect(shipped.body.data.autoReleaseAt).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(sentSubjects.get(customer.email)?.some((s) => s.includes('shipped'))).toBe(true);

    const before = (await call('get', '/api/v1/vendor/wallet', regular.accessToken)).body.data;
    const confirmed = await call(
      'post',
      `/api/v1/orders/${order.id}/vendor-orders/${vo.id}/confirm-delivery`,
      customer.accessToken,
    ).expect(200);
    expect(confirmed.body.data.vendorOrders.find((v: { id: string }) => v.id === vo.id).status).toBe('delivered');
    await tick(app);
    const after = (await call('get', '/api/v1/vendor/wallet', regular.accessToken)).body.data;
    expect(after.available.cents - before.available.cents).toBe(1900);
    expect(after.history[0]).toMatchObject({ kind: 'payout', amount: '19', status: 'confirmed', orderNumber: order.number });
    expect(after.history[0].explorerUrl).toBeTruthy();
    const listed = await call('get', `/api/v1/vendor/orders/${vo.id}`, regular.accessToken).expect(200);
    expect(listed.body.data.escrowStatus).toBe('paid_out');
  });

  it('releases escrow automatically 7 days after shipping', async () => {
    const { order } = await checkout([1, 0]);
    chain.pay(chain.externalWallet('20'), { destination: settlement, amount: '12.5', memo: order.number });
    await tick(app);
    const { rows } = await pool.query<{ id: string }>(
      `SELECT vo.id FROM vendor_orders vo JOIN orders o ON o.id = vo.order_id WHERE o.number = $1`,
      [order.number],
    );
    await call('patch', `/api/v1/vendor/orders/${rows[0].id}/status`, founding.accessToken)
      .send({ status: 'shipped', trackingNumber: 'KWIK-1' })
      .expect(200);
    await pool.query(`UPDATE vendor_orders SET auto_release_at = now() - interval '1 minute' WHERE id = $1`, [rows[0].id]);
    await tick(app);
    const vo = await call('get', `/api/v1/vendor/orders/${rows[0].id}`, founding.accessToken).expect(200);
    expect(vo.body.data.escrowStatus).toBe('paid_out');
  });

  it('holds the payout on a problem report, then refunds the customer (C8, refunds)', async () => {
    const { customer, order } = await checkout([1, 1]);
    const wallet = chain.externalWallet('40');
    chain.pay(wallet, { destination: settlement, amount: '32.5', memo: order.number });
    await tick(app);
    const vo = (await getOrder(customer, order.id)).vendorOrders.find(
      (v: { vendorSlug: string }) => v.vendorSlug === regular.slug,
    );
    await call('post', `/api/v1/orders/${order.id}/vendor-orders/${vo.id}/problem`, customer.accessToken)
      .send({ reason: 'Nothing arrived' })
      .expect(409); // not shipped yet
    await call('patch', `/api/v1/vendor/orders/${vo.id}/status`, regular.accessToken)
      .send({ status: 'shipped', trackingNumber: 'GIG-9' })
      .expect(200);
    const reported = await call('post', `/api/v1/orders/${order.id}/vendor-orders/${vo.id}/problem`, customer.accessToken)
      .send({ reason: 'The jar arrived broken.' })
      .expect(200);
    expect(reported.body.data.vendorOrders.find((v: { id: string }) => v.id === vo.id).problemReason).toBe('The jar arrived broken.');

    const disputes = await call('get', '/api/v1/admin/vendor-orders?escrowStatus=disputed&limit=100', admin.accessToken).expect(200);
    expect(disputes.body.data.result.map((d: { id: string }) => d.id)).toContain(vo.id);
    await call('post', `/api/v1/admin/vendor-orders/${vo.id}/refund`, admin.accessToken)
      .send({ reason: 'Damaged on arrival' })
      .expect(202);
    await tick(app);
    expect(chain.usdc(wallet.publicKey())).toBe('27.5'); // 40 − 32.5 + 20
    const refunds = await call('get', '/api/v1/admin/transfers/refund?limit=100', admin.accessToken).expect(200);
    expect(refunds.body.data.result.find((r: { destination: string }) => r.destination === wallet.publicKey()))
      .toMatchObject({ status: 'confirmed', amount: '20' });
  });

  it('flags unmatched and overpaid payments for an admin refund (rule 3, A4)', async () => {
    const stranger = chain.externalWallet('30');
    chain.pay(stranger, { destination: settlement, amount: '5', memo: 'NOT-AN-ORDER' });
    const { order } = await checkout([1, 0]);
    const generous = chain.externalWallet('30');
    chain.pay(generous, { destination: settlement, amount: '15', memo: order.number });
    await tick(app);

    const flagged = await call('get', '/api/v1/admin/payments?needsRefund=true&limit=100', admin.accessToken).expect(200);
    const unmatched = flagged.body.data.result.find((p: { payer: string }) => p.payer === stranger.publicKey());
    const overpaid = flagged.body.data.result.find((p: { payer: string }) => p.payer === generous.publicKey());
    expect(unmatched).toMatchObject({ status: 'unmatched', refundable: '5', note: 'No order has the memo "NOT-AN-ORDER"' });
    expect(overpaid).toMatchObject({ status: 'overpaid', refundable: '2.5', orderNumber: order.number });

    await call('post', `/api/v1/admin/payments/${unmatched.id}/refund`, admin.accessToken).send({ reason: 'Wrong memo' }).expect(202);
    await call('post', `/api/v1/admin/payments/${unmatched.id}/refund`, admin.accessToken).send({ reason: 'Again' }).expect(409);
    await tick(app);
    expect(chain.usdc(stranger.publicKey())).toBe('30');
    const after = await call('get', `/api/v1/admin/payments?q=${stranger.publicKey()}`, admin.accessToken).expect(200);
    expect(after.body.data.result[0]).toMatchObject({ status: 'refunded', refundable: '0' });
  });

  it('expires an unpaid checkout and puts the stock back', async () => {
    const before = (await call('get', `/api/v1/vendor/products/${jar.id}`, regular.accessToken)).body.data.stock;
    const { customer, order } = await checkout([1, 1]);
    const held = (await call('get', `/api/v1/vendor/products/${jar.id}`, regular.accessToken)).body.data.stock;
    expect(held).toBe(before - 1);
    await pool.query(`UPDATE orders SET expires_at = now() - interval '1 second' WHERE id = $1`, [order.id]);
    await tick(app);
    expect((await getOrder(customer, order.id)).status).toBe('expired');
    const restored = (await call('get', `/api/v1/vendor/products/${jar.id}`, regular.accessToken)).body.data.stock;
    expect(restored).toBe(before);
    // A late payment to an expired order is flagged, never credited.
    const late = chain.externalWallet('20');
    chain.pay(late, { destination: settlement, amount: '12.5', memo: order.number });
    await tick(app);
    const flagged = await call('get', `/api/v1/admin/payments?q=${late.publicKey()}`, admin.accessToken).expect(200);
    expect(flagged.body.data.result[0]).toMatchObject({ status: 'unmatched', refundable: '12.5' });
  });

  it('never counts a payment twice, even when the watcher replays the ledger', async () => {
    const { customer, order } = await checkout([1, 0]);
    chain.pay(chain.externalWallet('20'), { destination: settlement, amount: '12.5', memo: order.number });
    await tick(app);
    await pool.query(`DELETE FROM chain_cursors`);
    await tick(app);
    const fresh = await getOrder(customer, order.id);
    expect(fresh).toMatchObject({ status: 'paid', paid: '12.5' });
    expect(fresh.transactions).toHaveLength(1);
  });

  it('withdraws to an external address with password and emailed code, within the daily limit (V6)', async () => {
    const vendorWallet = (await call('get', '/api/v1/vendor/wallet', regular.accessToken)).body.data;
    expect(vendorWallet.available.cents).toBeGreaterThan(1000);
    const destination = chain.externalWallet('0');
    await call('post', '/api/v1/vendor/wallet/withdrawals', regular.accessToken)
      .send({ destination: Keypair.random().publicKey(), amountCents: 1000 })
      .expect(400); // destination has no account / trustline
    await call('post', '/api/v1/vendor/wallet/withdrawals', regular.accessToken)
      .send({ destination: destination.publicKey(), amountCents: 100_000_00 })
      .expect(400); // over the daily limit
    const started = await call('post', '/api/v1/vendor/wallet/withdrawals', regular.accessToken)
      .send({ destination: destination.publicKey(), amountCents: 1000 })
      .expect(201);
    expect(started.body.data.status).toBe('awaiting_confirmation');
    const code = mailbox.get(regular.email)!;
    const confirm = (body: object) =>
      call('post', `/api/v1/vendor/wallet/withdrawals/${started.body.data.id}/confirm`, regular.accessToken).send(body);
    await confirm({ password: 'wrong-password', code }).expect(400);
    await confirm({ password: PASSWORD, code: code === '000000' ? '111111' : '000000' }).expect(400);
    // A wrong password does not burn the code.
    const sent = await confirm({ password: PASSWORD, code }).expect(200);
    expect(sent.body.data).toMatchObject({ status: 'confirmed', amount: '10', destination: destination.publicKey() });
    await confirm({ password: PASSWORD, code }).expect(409);
    // While a code is live, a second request inside the cooldown is refused before anything is created.
    const pending = await call('post', '/api/v1/vendor/wallet/withdrawals', regular.accessToken)
      .send({ destination: destination.publicKey(), amountCents: 500 })
      .expect(201);
    await call('post', '/api/v1/vendor/wallet/withdrawals', regular.accessToken)
      .send({ destination: destination.publicKey(), amountCents: 500 })
      .expect(429);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM withdrawals WHERE user_id = $1 AND state = 'awaiting_confirmation'`,
      [regular.userId],
    );
    expect(rows[0].n).toBe(1);
    await call('delete', `/api/v1/vendor/wallet/withdrawals/${pending.body.data.id}`, regular.accessToken).expect(204);
    expect(chain.usdc(destination.publicKey())).toBe('10');
  });

  it('reports the dashboard and keeps payments admin-only (A2)', async () => {
    const res = await call('get', '/api/v1/admin/dashboard?days=7', admin.accessToken).expect(200);
    const today = res.body.data.series.at(-1);
    expect(today.paidOrders).toBeGreaterThan(0);
    expect(today.volume.cents).toBeGreaterThan(0);
    expect(res.body.data.queues).toHaveProperty('paymentsToRefund');
    await call('get', '/api/v1/admin/payments', regular.accessToken).expect(403);
    await call('get', '/api/v1/vendor/wallet', admin.accessToken).expect(403);
  });
});
