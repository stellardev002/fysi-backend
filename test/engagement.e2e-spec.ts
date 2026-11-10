import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Pool } from 'pg';
import { MarketingService } from '../src/marketing/marketing.service.js';
import { chain } from './fake-chain.js';
import {
  api,
  approvedVendor,
  categoryId,
  createPool,
  createProduct,
  createTestApp,
  PASSWORD,
  registerAdmin,
  registerCustomer,
  sentSubjects,
  type Session,
  setupPayments,
  tick,
  uniqueEmail,
} from './helpers.js';

const ADDRESS = {
  recipientName: 'Grace Ajayi',
  phone: '+2348031234567',
  line1: '14 Bourdillon Road',
  city: 'Ikoyi',
  state: 'Lagos',
};

type VendorSession = Session & { slug: string };

describe('Storefront, vendor and admin screens (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;
  let call: ReturnType<typeof api>;
  let admin: Session;
  let vendor: VendorSession;
  let settlement: string;
  let tote: { id: string; slug: string };
  let jar: { id: string; slug: string };

  beforeAll(async () => {
    app = await createTestApp();
    pool = createPool();
    call = api(app);
    settlement = (await setupPayments(app)).publicKey;
    admin = await registerAdmin(app, pool);
    vendor = await approvedVendor(app, admin);
    tote = await createProduct(app, vendor, { priceCents: 1250, stock: 30 });
    jar = await createProduct(app, vendor, { title: 'Glass storage jar', priceCents: 2000, stock: 30 });
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  const inbox = async (s: Session) =>
    (await call('get', '/api/v1/inbox?limit=100', s.accessToken).expect(200)).body.data.result as {
      id: string;
      kind: string;
      title: string;
      read: boolean;
    }[];

  /** Checkout from the cart and pay it in full from an external wallet. */
  async function paidOrder(customer: Session, lines: [{ id: string }, number][], body: object = { deliveryAddress: ADDRESS }) {
    for (const [p, quantity] of lines)
      await call('put', `/api/v1/cart/items/${p.id}`, customer.accessToken).send({ quantity }).expect(200);
    const res = await call('post', '/api/v1/checkout', customer.accessToken).send(body).expect(201);
    const order = res.body.data;
    chain.pay(chain.externalWallet('500'), { destination: settlement, amount: order.payment.amountDue, memo: order.number });
    await tick(app);
    const fresh = await call('get', `/api/v1/orders/${order.id}`, customer.accessToken).expect(200);
    expect(fresh.body.data.status).toBe('paid');
    return fresh.body.data as { id: string; number: string; vendorOrders: { id: string; lines: { unitPrice: { cents: number } }[] }[] };
  }

  async function deliver(customer: Session, orderId: string, voId: string) {
    await call('patch', `/api/v1/vendor/orders/${voId}/status`, vendor.accessToken)
      .send({ status: 'shipped', carrier: 'GIG Logistics', trackingNumber: `GIG-${voId.slice(-6)}` })
      .expect(200);
    await call('post', `/api/v1/orders/${orderId}/vendor-orders/${voId}/confirm-delivery`, customer.accessToken).expect(200);
  }

  it('keeps a wishlist with live prices', async () => {
    const customer = await registerCustomer(app);
    await call('put', `/api/v1/wishlist/${tote.id}`, customer.accessToken).expect(200);
    const again = await call('put', `/api/v1/wishlist/${tote.id}`, customer.accessToken).expect(200);
    expect(again.body.data).toMatchObject({ productId: tote.id, saved: true, count: 1 });
    await call('put', `/api/v1/wishlist/00000000-0000-7000-8000-000000000000`, customer.accessToken).expect(404);
    const list = await call('get', '/api/v1/wishlist', customer.accessToken).expect(200);
    expect(list.body.data.result).toHaveLength(1);
    expect(list.body.data.result[0].product).toMatchObject({ id: tote.id, price: { cents: 1250 } });
    const removed = await call('delete', `/api/v1/wishlist/${tote.id}`, customer.accessToken).expect(200);
    expect(removed.body.data.saved).toBe(false);
    // Customers only.
    await call('get', '/api/v1/wishlist', vendor.accessToken).expect(403);
  });

  it('saves addresses with one default, and checks out with one', async () => {
    const customer = await registerCustomer(app);
    const home = await call('post', '/api/v1/addresses', customer.accessToken).send({ ...ADDRESS, label: 'Home' }).expect(201);
    expect(home.body.data.isDefault).toBe(true);
    const office = await call('post', '/api/v1/addresses', customer.accessToken)
      .send({ ...ADDRESS, label: 'Office', line1: '3 Broad Street', city: 'Lagos Island', isDefault: true })
      .expect(201);
    let list = (await call('get', '/api/v1/addresses', customer.accessToken).expect(200)).body.data;
    expect(list.map((a: { label: string; isDefault: boolean }) => [a.label, a.isDefault])).toEqual([
      ['Office', true],
      ['Home', false],
    ]);
    await call('delete', `/api/v1/addresses/${office.body.data.id}`, customer.accessToken).expect(200);
    list = (await call('get', '/api/v1/addresses', customer.accessToken).expect(200)).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ label: 'Home', isDefault: true });

    await call('put', `/api/v1/cart/items/${jar.id}`, customer.accessToken).send({ quantity: 1 }).expect(200);
    await call('post', '/api/v1/checkout', customer.accessToken).send({}).expect(400);
    const order = await call('post', '/api/v1/checkout', customer.accessToken).send({ addressId: home.body.data.id }).expect(201);
    expect(order.body.data.deliveryAddress).toMatchObject({ line1: '14 Bourdillon Road', city: 'Ikoyi' });
  });

  it('runs a vendor promotion through the storefront, cart and checkout', async () => {
    const created = await call('post', '/api/v1/vendor/promotions', vendor.accessToken)
      .send({
        name: 'Launch week',
        discountPercent: 20,
        startsAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        productIds: [tote.id],
      })
      .expect(201);
    expect(created.body.data).toMatchObject({ state: 'running', discountPercent: 20 });
    expect(created.body.data.products[0].salePrice.cents).toBe(1000);
    // Other stores' products cannot be put on sale.
    await call('post', '/api/v1/vendor/promotions', vendor.accessToken)
      .send({ name: 'X', discountPercent: 10, startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString(), productIds: ['00000000-0000-7000-8000-000000000000'] })
      .expect(400);

    const page = await call('get', `/api/v1/products/${tote.slug}`).expect(200);
    expect(page.body.data).toMatchObject({ price: { cents: 1000 }, originalPrice: { cents: 1250 }, discountPercent: 20 });

    const customer = await registerCustomer(app);
    await call('put', `/api/v1/cart/items/${tote.id}`, customer.accessToken).send({ quantity: 2 }).expect(200);
    const cart = await call('get', '/api/v1/cart', customer.accessToken).expect(200);
    expect(cart.body.data.subtotal.cents).toBe(2000);
    const order = await paidOrder(customer, []);
    expect(order.vendorOrders[0].lines[0].unitPrice.cents).toBe(1000);

    const stats = await call('get', `/api/v1/vendor/promotions/${created.body.data.id}`, vendor.accessToken).expect(200);
    expect(stats.body.data.stats).toMatchObject({ orders: 1, unitsSold: 2, revenue: { cents: 2000 }, discountGiven: { cents: 500 } });

    await call('post', `/api/v1/vendor/promotions/${created.body.data.id}/end`, vendor.accessToken).expect(200);
    const after = await call('get', `/api/v1/products/${tote.slug}`).expect(200);
    expect(after.body.data).toMatchObject({ price: { cents: 1250 }, originalPrice: null });
    await call('post', `/api/v1/vendor/promotions/${created.body.data.id}/resume`, vendor.accessToken).expect(409);
  });

  it('fills inboxes on payment and lets the vendor search and cancel', async () => {
    const customer = await registerCustomer(app);
    const order = await paidOrder(customer, [[jar, 1]]);
    expect((await inbox(customer)).map((n) => n.kind)).toContain('order.paid');
    const vendorInbox = await inbox(vendor);
    expect(vendorInbox.some((n) => n.kind === 'order.new' && n.title.includes(order.number))).toBe(true);
    const unread = await call('get', '/api/v1/inbox/unread-count', customer.accessToken).expect(200);
    expect(unread.body.data.unread).toBeGreaterThan(0);
    await call('post', '/api/v1/inbox/read-all', customer.accessToken).expect(200);
    expect((await call('get', '/api/v1/inbox/unread-count', customer.accessToken)).body.data.unread).toBe(0);

    // Track Orders search.
    const found = await call('get', `/api/v1/vendor/orders?q=${order.number}`, vendor.accessToken).expect(200);
    expect(found.body.data.result).toHaveLength(1);
    expect(found.body.data.result[0]).toMatchObject({ canCancel: true });
    const toShip = await call('get', '/api/v1/vendor/orders?view=to_ship&limit=100', vendor.accessToken).expect(200);
    expect(toShip.body.data.result.map((v: { orderNumber: string }) => v.orderNumber)).toContain(order.number);
    const byProduct = await call('get', '/api/v1/vendor/orders?q=storage%20jar&limit=100', vendor.accessToken).expect(200);
    expect(byProduct.body.data.result.length).toBeGreaterThan(0);

    const stockBefore = (await call('get', `/api/v1/vendor/products/${jar.id}`, vendor.accessToken)).body.data.stock;
    const voId = order.vendorOrders[0].id;
    const cancelled = await call('post', `/api/v1/vendor/orders/${voId}/cancel`, vendor.accessToken)
      .send({ reason: 'The last jar cracked in the workshop.' })
      .expect(200);
    expect(cancelled.body.data).toMatchObject({ status: 'cancelled', escrowStatus: 'refunded', canCancel: false });
    expect((await call('get', `/api/v1/vendor/products/${jar.id}`, vendor.accessToken)).body.data.stock).toBe(stockBefore + 1);
    await call('post', `/api/v1/vendor/orders/${voId}/cancel`, vendor.accessToken).send({ reason: 'Again please' }).expect(409);
    await tick(app);
    expect((await inbox(customer)).map((n) => n.kind)).toContain('order.cancelled');
    await new Promise((r) => setTimeout(r, 50));
    expect(sentSubjects.get(customer.email)?.some((s) => s.includes('cancelled'))).toBe(true);
  });

  it('collects verified-purchase reviews and lets admins hide them', async () => {
    const customer = await registerCustomer(app);
    const order = await paidOrder(customer, [[tote, 1]]);
    const voId = order.vendorOrders[0].id;
    expect((await call('get', '/api/v1/reviews/pending', customer.accessToken)).body.data.result).toHaveLength(0);
    await deliver(customer, order.id, voId);
    const pending = (await call('get', '/api/v1/reviews/pending', customer.accessToken).expect(200)).body.data.result;
    expect(pending).toHaveLength(1);
    const review = await call('post', '/api/v1/reviews', customer.accessToken)
      .send({ orderLineId: pending[0].orderLineId, rating: 4, title: 'Sturdy', body: 'Carries all my groceries without trouble.' })
      .expect(201);
    expect(review.body.data).toMatchObject({ rating: 4, author: 'Grace A.', verifiedPurchase: true, status: 'visible' });
    await call('post', '/api/v1/reviews', customer.accessToken)
      .send({ orderLineId: pending[0].orderLineId, rating: 5, body: 'Trying to review twice here.' })
      .expect(409);
    // Someone else's order line.
    const other = await registerCustomer(app);
    await call('post', '/api/v1/reviews', other.accessToken)
      .send({ orderLineId: pending[0].orderLineId, rating: 1, body: 'I never bought this one.' })
      .expect(404);

    const page = await call('get', `/api/v1/products/${tote.slug}`).expect(200);
    expect(page.body.data.rating.count).toBeGreaterThanOrEqual(1);
    const summary = await call('get', `/api/v1/products/${tote.slug}/reviews/summary`).expect(200);
    expect(summary.body.data.distribution['4']).toBeGreaterThanOrEqual(1);
    expect((await inbox(vendor)).some((n) => n.kind === 'review.new')).toBe(true);

    await call('post', `/api/v1/admin/reviews/${review.body.data.id}/hide`, admin.accessToken)
      .send({ reason: 'Contains a phone number' })
      .expect(200);
    const publicList = await call('get', `/api/v1/products/${tote.slug}/reviews?limit=100`).expect(200);
    expect(publicList.body.data.result.map((r: { id: string }) => r.id)).not.toContain(review.body.data.id);
    const mine = await call('get', '/api/v1/reviews', customer.accessToken).expect(200);
    expect(mine.body.data.result[0]).toMatchObject({ status: 'hidden', moderationReason: 'Contains a phone number' });
  });

  it('runs the help desk: Report a Problem, order problems and admin replies', async () => {
    // Guests must say who they are.
    await call('post', '/api/v1/support/tickets')
      .send({ category: 'account', subject: 'Cannot sign in', message: 'The code never arrives in my inbox.' })
      .expect(400);
    const guestEmail = uniqueEmail();
    const guest = await call('post', '/api/v1/support/tickets')
      .send({ category: 'account', subject: 'Cannot sign in', message: 'The code never arrives in my inbox.', name: 'Tunde', email: guestEmail })
      .expect(201);
    expect(guest.body.data.number).toMatch(/^TK[A-Z2-9]{10}$/);
    await new Promise((r) => setTimeout(r, 50));
    expect(sentSubjects.get(guestEmail)?.[0]).toContain(guest.body.data.number);

    const customer = await registerCustomer(app);
    const order = await paidOrder(customer, [[tote, 1]]);
    await call('post', '/api/v1/support/tickets', customer.accessToken)
      .send({ category: 'order', subject: 'Wrong order', message: 'This is not my order at all.', orderNumber: 'FYAAAAAAAAAA' })
      .expect(400);
    const linked = await call('post', '/api/v1/support/tickets', customer.accessToken)
      .send({ category: 'delivery', subject: 'Where is my tote?', message: 'Paid yesterday, no news yet.', orderNumber: order.number })
      .expect(201);
    expect(linked.body.data.orderNumber).toBe(order.number);

    // The order problem report opens a high-priority ticket and tells the vendor.
    const voId = order.vendorOrders[0].id;
    await call('patch', `/api/v1/vendor/orders/${voId}/status`, vendor.accessToken)
      .send({ status: 'shipped', trackingNumber: 'GIG-55' })
      .expect(200);
    await call('post', `/api/v1/orders/${order.id}/vendor-orders/${voId}/problem`, customer.accessToken)
      .send({ reason: 'The tote arrived torn at the handle.' })
      .expect(200);
    const mine = (await call('get', '/api/v1/support/tickets', customer.accessToken).expect(200)).body.data.result;
    const problem = mine.find((t: { vendorOrderId: string | null }) => t.vendorOrderId === voId);
    expect(problem).toMatchObject({ category: 'order', priority: 'high', status: 'open' });
    expect((await inbox(vendor)).some((n) => n.kind === 'order.problem')).toBe(true);
    expect((await inbox(admin)).some((n) => n.kind === 'ticket.new')).toBe(true);

    const queue = await call('get', `/api/v1/admin/tickets?q=${order.number}&limit=100`, admin.accessToken).expect(200);
    expect(queue.body.data.result.length).toBe(2);
    expect(queue.body.data.result[0].priority).toBe('high');
    const replied = await call('post', `/api/v1/admin/tickets/${problem.id}/messages`, admin.accessToken)
      .send({ body: 'Sorry about that. Please send a photo of the handle.' })
      .expect(201);
    expect(replied.body.data).toMatchObject({ status: 'pending', assignedTo: admin.userId, messageCount: 2 });
    expect((await inbox(customer)).some((n) => n.kind === 'ticket.reply')).toBe(true);
    expect(sentSubjects.get(customer.email)?.some((s) => s.includes('Fysi support replied'))).toBe(true);

    const back = await call('post', `/api/v1/support/tickets/${problem.id}/messages`, customer.accessToken)
      .send({ body: 'Photo attached to my email.' })
      .expect(201);
    expect(back.body.data.status).toBe('open');
    await call('post', `/api/v1/support/tickets/${problem.id}/close`, customer.accessToken).expect(200);
    await call('post', `/api/v1/support/tickets/${problem.id}/messages`, customer.accessToken).send({ body: 'One more' }).expect(409);
    // Nobody else's ticket.
    await call('get', `/api/v1/support/tickets/${problem.id}`, (await registerCustomer(app)).accessToken).expect(404);
  });

  it('subscribes to the newsletter, sends a campaign and honours unsubscribes', async () => {
    const reader = uniqueEmail();
    const leaver = uniqueEmail();
    for (const email of [reader, leaver])
      await call('post', '/api/v1/newsletter/subscribe').send({ email, source: 'footer' }).expect(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(sentSubjects.get(reader)?.[0]).toBe('Welcome to the Fysi newsletter');
    // Subscribing again sends no second welcome.
    await call('post', '/api/v1/newsletter/subscribe').send({ email: reader }).expect(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(sentSubjects.get(reader)).toHaveLength(1);

    await call('post', '/api/v1/newsletter/unsubscribe').send({ email: leaver, token: 'x'.repeat(32) }).expect(400);
    const token = new URL(app.get(MarketingService).unsubscribeUrl(leaver)).searchParams.get('token');
    await call('post', '/api/v1/newsletter/unsubscribe').send({ email: leaver, token }).expect(200);

    const campaign = await call('post', '/api/v1/admin/campaigns', admin.accessToken)
      .send({
        name: 'Test campaign',
        subject: `Eco picks ${Date.now()}`,
        heading: 'New this week',
        body: 'Three new vendors joined.\n\nAll verified.',
        ctaLabel: 'Shop',
        ctaUrl: 'https://fysi.test/new',
        audience: 'newsletter',
      })
      .expect(201);
    expect(campaign.body.data.status).toBe('draft');
    await call('patch', `/api/v1/admin/campaigns/${campaign.body.data.id}`, admin.accessToken).send({ ctaUrl: null }).expect(400);
    await call('post', `/api/v1/admin/campaigns/${campaign.body.data.id}/test`, admin.accessToken).send({}).expect(200);
    expect(sentSubjects.get(admin.email)?.at(-1)).toMatch(/^\[Test\]/);

    await call('post', `/api/v1/admin/campaigns/${campaign.body.data.id}/send`, admin.accessToken).send({}).expect(200);
    await app.get(MarketingService).processCampaigns();
    await app.get(MarketingService).processCampaigns();
    const sent = await call('get', `/api/v1/admin/campaigns/${campaign.body.data.id}`, admin.accessToken).expect(200);
    expect(sent.body.data.status).toBe('sent');
    expect(sent.body.data.sentCount).toBe(sent.body.data.recipientCount);
    expect(sentSubjects.get(reader)?.at(-1)).toBe(campaign.body.data.subject);
    expect(sentSubjects.get(leaver)?.some((s) => s === campaign.body.data.subject)).toBe(false);
    await call('patch', `/api/v1/admin/campaigns/${campaign.body.data.id}`, admin.accessToken).send({ name: 'Late' }).expect(409);

    const subs = await call('get', `/api/v1/admin/newsletter/subscribers?q=${encodeURIComponent(leaver)}`, admin.accessToken).expect(200);
    expect(subs.body.data.result[0]).toMatchObject({ email: leaver, status: 'unsubscribed' });
  });

  it('broadcasts announcements to inboxes', async () => {
    await call('post', '/api/v1/admin/notifications', vendor.accessToken)
      .send({ audience: 'vendors', title: 'Nope', body: 'Vendors cannot broadcast.' })
      .expect(403);
    const sent = await call('post', '/api/v1/admin/notifications', admin.accessToken)
      .send({ audience: 'vendors', title: 'Black Friday prep', body: 'Set up your promotions before Sunday.', link: '/vendor/promotions' })
      .expect(201);
    expect(sent.body.data.recipientCount).toBeGreaterThan(0);
    const note = (await inbox(vendor)).find((n) => n.kind === 'announcement' && n.title === 'Black Friday prep')!;
    expect(note).toBeTruthy();
    await call('post', `/api/v1/inbox/${note.id}/read`, vendor.accessToken).expect(200);
    const list = await call('get', '/api/v1/admin/notifications', admin.accessToken).expect(200);
    expect(list.body.data.result[0]).toMatchObject({ title: 'Black Friday prep', readCount: 1 });
  });

  it('reports the vendor dashboard, analytics, product stats and statement', async () => {
    const dashboard = await call('get', '/api/v1/vendor/dashboard', vendor.accessToken).expect(200);
    expect(dashboard.body.data.orders.problems).toBeGreaterThanOrEqual(1);
    expect(dashboard.body.data.products.active).toBe(2);
    expect(dashboard.body.data.last30DaysOrders).toBeGreaterThan(0);

    const analytics = await call('get', '/api/v1/vendor/analytics?period=day', vendor.accessToken).expect(200);
    expect(analytics.body.data.orders.value).toBe(dashboard.body.data.last30DaysOrders);
    expect(analytics.body.data.refunds.value.cents).toBe(2000);
    expect(analytics.body.data.views.value).toBeGreaterThan(0);
    expect(analytics.body.data.series.length).toBeGreaterThan(0);
    expect(analytics.body.data.topProducts[0].title).toBe('Organic cotton tote bag');

    const stats = await call('get', '/api/v1/vendor/product-stats?sort=units', vendor.accessToken).expect(200);
    expect(stats.body.data.result[0]).toMatchObject({ productId: tote.id });
    expect(stats.body.data.result[0].views).toBeGreaterThan(0);
    const one = await call('get', `/api/v1/vendor/product-stats/${tote.id}`, vendor.accessToken).expect(200);
    expect(one.body.data.viewSeries.length).toBe(1);

    const statement = await call('get', '/api/v1/vendor/statements', vendor.accessToken).expect(200);
    const s = statement.body.data;
    expect(s.entries.some((e: { type: string }) => e.type === 'refund')).toBe(true);
    expect(s.closingBalance.cents).toBe(s.openingBalance.cents + s.netEarnings.cents - s.withdrawals.cents);
    expect(s.entries.at(-1).balance.cents).toBe(s.closingBalance.cents);

    const csv = await call('get', '/api/v1/vendor/statements/export.csv', vendor.accessToken).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(/attachment; filename="fysi-statement-/);
    expect(csv.text.split('\r\n')[0]).toBe('﻿Date,Type,Reference,Description,Amount (USD),Balance (USD),Status');
    const orders = await call('get', '/api/v1/vendor/exports/orders.csv?view=problem', vendor.accessToken).expect(200);
    expect(orders.text.trim().split('\r\n').length).toBeGreaterThanOrEqual(2);
    const products = await call('get', '/api/v1/vendor/exports/products.csv', vendor.accessToken).expect(200);
    expect(products.text).toContain('Glass storage jar');
  });

  it('reports marketplace analytics and exports CSV for admins', async () => {
    const res = await call('get', '/api/v1/admin/analytics', admin.accessToken).expect(200);
    expect(res.body.data.gmv.value.cents).toBeGreaterThan(0);
    expect(res.body.data.topVendors.length).toBeGreaterThan(0);
    expect(res.body.data.newCustomers.value).toBeGreaterThan(0);
    for (const kind of ['users', 'customers', 'vendors', 'orders', 'payments', 'products', 'newsletter', 'tickets']) {
      const csv = await call('get', `/api/v1/admin/exports/${kind}.csv?from=2026-01-01`, admin.accessToken).expect(200);
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      expect(csv.text.trim().split('\r\n').length).toBeGreaterThanOrEqual(1);
    }
    await call('get', '/api/v1/admin/exports/orders.csv', vendor.accessToken).expect(403);
  });

  it('lets admins add and edit a product for a vendor', async () => {
    const category = await categoryId(app, 'household');
    const created = await call('post', '/api/v1/admin/products', admin.accessToken)
      .send({
        vendorId: vendor.userId,
        title: 'Bamboo toothbrush set',
        description: 'Four compostable bamboo toothbrushes with plant-based bristles.',
        priceCents: 900,
        stock: 100,
        categoryId: category,
      })
      .expect(201);
    expect(created.body.data).toMatchObject({ vendorId: vendor.userId, title: 'Bamboo toothbrush set', isPublic: true });
    const edited = await call('patch', `/api/v1/admin/products/${created.body.data.id}`, admin.accessToken)
      .send({ priceCents: 850 })
      .expect(200);
    expect(edited.body.data.price.cents).toBe(850);
    // The vendor manages it as their own.
    await call('get', `/api/v1/vendor/products/${created.body.data.id}`, vendor.accessToken).expect(200);
    const log = await call('get', `/api/v1/audit-logs?actorId=${admin.userId}&limit=100`, admin.accessToken).expect(200);
    expect(log.body.data.result.map((e: { action: string }) => e.action)).toContain('product.created');
  });

  it('deletes a customer account, erasing personal data but keeping orders', async () => {
    // Blocked while money is in escrow.
    const busy = await registerCustomer(app);
    await paidOrder(busy, [[tote, 1]]);
    const blocked = await call('delete', `/api/v1/admin/users/${busy.userId}`, admin.accessToken)
      .send({ reason: 'Customer asked' })
      .expect(409);
    expect(blocked.body.error.details[0]).toMatch(/escrow/);
    await call('delete', `/api/v1/admin/users/${vendor.userId}`, admin.accessToken).send({ reason: 'No' }).expect(400);

    // A customer whose order was delivered and reviewed.
    const leaving = await registerCustomer(app);
    const order = await paidOrder(leaving, [[jar, 1]]);
    await deliver(leaving, order.id, order.vendorOrders[0].id);
    await tick(app);
    const line = (await call('get', '/api/v1/reviews/pending', leaving.accessToken)).body.data.result[0];
    const review = await call('post', '/api/v1/reviews', leaving.accessToken)
      .send({ orderLineId: line.orderLineId, rating: 5, body: 'Lovely jar, keeps my rice dry.' })
      .expect(201);
    await call('put', `/api/v1/wishlist/${tote.id}`, leaving.accessToken).expect(200);

    const deleted = await call('delete', `/api/v1/admin/users/${leaving.userId}`, admin.accessToken)
      .send({ reason: 'Customer asked for deletion by email' })
      .expect(200);
    expect(deleted.body.data).toMatchObject({ name: 'Deleted customer', phone: null });
    expect(deleted.body.data.deletedAt).toBeTruthy();
    expect(deleted.body.data.email).not.toBe(leaving.email);
    await call('get', '/api/v1/auth/me', leaving.accessToken).expect(401);
    await call('post', '/api/v1/auth/login').send({ email: leaving.email, password: PASSWORD }).expect(401);
    await call('delete', `/api/v1/admin/users/${leaving.userId}`, admin.accessToken).send({ reason: 'Again' }).expect(409);

    // Orders stay for the vendor; the review shows an anonymous author.
    await call('get', `/api/v1/vendor/orders/${order.vendorOrders[0].id}`, vendor.accessToken).expect(200);
    const reviews = await call('get', `/api/v1/products/${jar.slug}/reviews?limit=100`).expect(200);
    expect(reviews.body.data.result.find((r: { id: string }) => r.id === review.body.data.id).author).toBe('Fysi customer');
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM wishlist_items WHERE user_id = $1`, [leaving.userId]);
    expect(rows[0].n).toBe(0);

    // The email is free again.
    await call('post', '/api/v1/auth/register')
      .send({ accountType: 'customer', name: 'Grace Again', email: leaving.email, password: PASSWORD })
      .expect(201);
  });
});
