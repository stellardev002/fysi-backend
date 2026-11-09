import { v7 } from 'uuid';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Pool } from 'pg';
import {
  api,
  approvedVendor,
  categoryId,
  createPool,
  createProduct,
  createTestApp,
  PNG_BYTES,
  registerAdmin,
  registerCustomer,
  registerVendor,
  type Session,
} from './helpers.js';

describe('Products, catalogue and cart (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;
  let call: ReturnType<typeof api>;
  let admin: Session;
  let vendor: Session & { slug: string };
  /** Unique word so searches only see this run's products. */
  const tag = `zx${v7().replace(/-/g, '').slice(-10)}`;

  beforeAll(async () => {
    app = await createTestApp();
    pool = createPool();
    call = api(app);
    admin = await registerAdmin(app, pool);
    vendor = await approvedVendor(app, admin);
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  describe('vendor products', () => {
    it('only lets verified stores list products', async () => {
      const draft = await registerVendor(app);
      const category = await categoryId(app);
      const res = await call('post', '/api/v1/vendor/products', draft.accessToken)
        .send({
          title: 'Bamboo toothbrush',
          description: 'Biodegradable bamboo handle, charcoal bristles.',
          priceCents: 150,
          stock: 10,
          categoryId: category,
        })
        .expect(403);
      expect(res.body.message).toBe('Your business must be verified before you can list products');
    });

    it('creates a product priced in dollars', async () => {
      const p = await createProduct(app, vendor, { title: `Tote ${tag}` });
      expect(p).toMatchObject({
        price: { cents: 1250, usd: '12.50' },
        badge: 'certified',
        certifications: [{ id: 'gots', name: 'GOTS' }],
        status: 'active',
        isPublic: true,
      });
      expect(p.slug).toMatch(/^tote-zx[a-f0-9]+-[a-z0-9]{6}$/);
    });

    it('refuses certifications the store is not verified for', async () => {
      const category = await categoryId(app, 'office-supplies');
      const res = await call('post', '/api/v1/vendor/products', vendor.accessToken)
        .send({
          title: 'Paper notebook',
          description: 'Recycled paper notebook, 120 pages.',
          priceCents: 300,
          stock: 5,
          categoryId: category,
          certifications: ['fsc'],
        })
        .expect(400);
      expect(res.body.message).toBe('Your store is not verified for: fsc');
    });

    it('adds, orders and removes photos; hides and deletes products', async () => {
      const p = await createProduct(app, vendor, { title: `Jar ${tag}` });
      const one = await call('post', `/api/v1/vendor/products/${p.id}/images`, vendor.accessToken)
        .attach('image', PNG_BYTES, 'a.png')
        .expect(201);
      const two = await call('post', `/api/v1/vendor/products/${p.id}/images`, vendor.accessToken)
        .attach('image', PNG_BYTES, 'b.png')
        .expect(201);
      const [a, b] = two.body.data.images.map((i: { id: string }) => i.id);
      expect(one.body.data.images).toHaveLength(1);
      const reordered = await call('put', `/api/v1/vendor/products/${p.id}/images/order`, vendor.accessToken)
        .send({ imageIds: [b, a] })
        .expect(200);
      expect(reordered.body.data.images.map((i: { id: string }) => i.id)).toEqual([b, a]);
      await call('delete', `/api/v1/vendor/products/${p.id}/images/${a}`, vendor.accessToken).expect(200);

      const hidden = await call('patch', `/api/v1/vendor/products/${p.id}`, vendor.accessToken)
        .send({ status: 'hidden' })
        .expect(200);
      expect(hidden.body.data.isPublic).toBe(false);
      await call('get', `/api/v1/products/${p.slug}`).expect(404);

      await call('delete', `/api/v1/vendor/products/${p.id}`, vendor.accessToken).expect(204);
      await call('get', `/api/v1/vendor/products/${p.id}`, vendor.accessToken).expect(404);
    });

    it("keeps one vendor out of another vendor's products", async () => {
      const other = await approvedVendor(app, admin);
      const p = await createProduct(app, vendor);
      await call('get', `/api/v1/vendor/products/${p.id}`, other.accessToken).expect(404);
      await call('patch', `/api/v1/vendor/products/${p.id}`, other.accessToken)
        .send({ stock: 0 })
        .expect(404);
      await call('delete', `/api/v1/vendor/products/${p.id}`, other.accessToken).expect(404);
    });
  });

  describe('public catalogue', () => {
    let cheap: { id: string; slug: string };
    let pricey: { id: string; slug: string };

    beforeAll(async () => {
      cheap = await createProduct(app, vendor, {
        title: `Bamboo toothbrush ${tag}`,
        description: 'Biodegradable bamboo handle with charcoal bristles.',
        priceCents: 150,
        certifications: [],
      });
      pricey = await createProduct(app, vendor, {
        title: `Organic duvet ${tag}`,
        description: 'Organic cotton duvet cover, king size, natural dyes.',
        priceCents: 9500,
        stock: 0,
      });
    });

    it('searches, filters and sorts without an account', async () => {
      const all = await call('get', `/api/v1/products?q=${tag}&sort=price_asc&limit=100`).expect(200);
      const slugs = all.body.data.result.map((p: { slug: string }) => p.slug);
      expect(slugs.indexOf(cheap.slug)).toBeLessThan(slugs.indexOf(pricey.slug));

      const bamboo = await call('get', `/api/v1/products?q=bamboo%20${tag}`).expect(200);
      expect(bamboo.body.data.result.map((p: { slug: string }) => p.slug)).toEqual([cheap.slug]);

      const partial = await call('get', `/api/v1/products?q=${tag.slice(0, 8)}&limit=100`).expect(200);
      expect(partial.body.data.result.length).toBeGreaterThanOrEqual(2);

      const capped = await call('get', `/api/v1/products?q=${tag}&maxPriceCents=200`).expect(200);
      expect(capped.body.data.result.map((p: { slug: string }) => p.slug)).toEqual([cheap.slug]);

      const reviewed = await call('get', `/api/v1/products?q=${tag}&certified=false`).expect(200);
      expect(reviewed.body.data.result).toHaveLength(1);
      expect(reviewed.body.data.result[0].badge).toBe('fysi_reviewed');

      const inStock = await call('get', `/api/v1/products?q=${tag}&inStock=true&limit=100`).expect(200);
      expect(inStock.body.data.result.map((p: { slug: string }) => p.slug)).not.toContain(pricey.slug);

      const store = await call('get', `/api/v1/products?vendor=${vendor.slug}&category=household&limit=100`).expect(200);
      expect(store.body.data.result.length).toBeGreaterThanOrEqual(2);

      await call('get', '/api/v1/products?minPriceCents=500&maxPriceCents=100').expect(400);
      await call('get', '/api/v1/products?sort=relevance').expect(400);
    });

    it('shows the product page with the verified vendor and the dollar price', async () => {
      const res = await call('get', `/api/v1/products/${cheap.slug}`).expect(200);
      expect(res.body.data).toMatchObject({
        slug: cheap.slug,
        price: { cents: 150, usd: '1.50' },
        inStock: true,
        badge: 'fysi_reviewed',
        vendor: { slug: vendor.slug, verified: true, badge: 'certified', city: 'Lekki' },
        description: expect.stringContaining('bamboo'),
      });
    });

    it('counts visible products per category', async () => {
      const res = await call('get', '/api/v1/categories').expect(200);
      // The six launch categories (other tests may add more).
      expect(res.body.data.map((c: { slug: string }) => c.slug)).toEqual(
        expect.arrayContaining([
          'clothing',
          'household',
          'beauty-personal-care',
          'gadgets',
          'office-supplies',
          'outdoor-travel',
        ]),
      );
      const household = res.body.data.find((c: { slug: string }) => c.slug === 'household');
      expect(household.productCount).toBeGreaterThanOrEqual(2);
    });

    it('lets admins hide, unhide and remove products', async () => {
      const p = await createProduct(app, vendor, { title: `Mod ${tag}` });
      const hidden = await call('post', `/api/v1/admin/products/${p.id}/hide`, admin.accessToken)
        .send({ reason: 'Photos show a different product.' })
        .expect(200);
      expect(hidden.body.data).toMatchObject({ moderationStatus: 'hidden', isPublic: false });
      await call('get', `/api/v1/products/${p.slug}`).expect(404);
      const mine = await call('get', `/api/v1/vendor/products/${p.id}`, vendor.accessToken).expect(200);
      expect(mine.body.data.moderationReason).toBe('Photos show a different product.');

      await call('post', `/api/v1/admin/products/${p.id}/unhide`, admin.accessToken).expect(200);
      await call('get', `/api/v1/products/${p.slug}`).expect(200);

      await call('post', `/api/v1/admin/products/${p.id}/remove`, admin.accessToken)
        .send({ reason: 'Not an eco-friendly product.' })
        .expect(200);
      await call('post', `/api/v1/admin/products/${p.id}/unhide`, admin.accessToken).expect(409);
      await call('patch', `/api/v1/vendor/products/${p.id}`, vendor.accessToken)
        .send({ stock: 1 })
        .expect(409);
    });

    it("takes a suspended vendor's products off the storefront", async () => {
      const other = await approvedVendor(app, admin);
      const p = await createProduct(app, other);
      await call('get', `/api/v1/products/${p.slug}`).expect(200);
      await call('post', `/api/v1/admin/users/${other.userId}/suspension`, admin.accessToken)
        .send({ reason: 'Fraud report under review' })
        .expect(201);
      await call('get', `/api/v1/products/${p.slug}`).expect(404);
    });
  });

  describe('cart', () => {
    let a: { id: string; slug: string };
    let b: { id: string; slug: string };
    let other: Session & { slug: string };

    beforeAll(async () => {
      a = await createProduct(app, vendor, { title: `Cart A ${tag}`, stock: 3, certifications: [] });
      other = await approvedVendor(app, admin);
      b = await createProduct(app, other, { title: `Cart B ${tag}`, priceCents: 200 });
    });

    it('prices a guest cart without an account', async () => {
      const res = await call('post', '/api/v1/cart/preview')
        .send({
          items: [
            { productId: a.id, quantity: 2 },
            { productId: b.id, quantity: 1 },
            { productId: '00000000-0000-7000-8000-000000000000', quantity: 1 },
          ],
        })
        .expect(200);
      expect(res.body.data).toMatchObject({
        subtotal: { cents: 2 * 1250 + 200, usd: '27.00' },
        itemCount: 3,
        vendorCount: 2,
        readyForCheckout: false,
      });
      expect(res.body.data.items[2]).toMatchObject({ issue: 'unavailable', product: null });
    });

    it('merges the guest cart at sign-up, idempotently, capped by stock', async () => {
      const customer = await registerCustomer(app);
      await call('put', `/api/v1/cart/items/${a.id}`, customer.accessToken)
        .send({ quantity: 1 })
        .expect(200);
      const guest = {
        items: [
          { productId: a.id, quantity: 9 },
          { productId: b.id, quantity: 2 },
          { productId: '00000000-0000-7000-8000-000000000000', quantity: 1 },
        ],
      };
      const merged = await call('post', '/api/v1/cart/merge', customer.accessToken)
        .send(guest)
        .expect(200);
      expect(merged.body.data.skipped).toEqual([
        { productId: '00000000-0000-7000-8000-000000000000', reason: 'unavailable' },
      ]);
      const quantities = Object.fromEntries(
        merged.body.data.items.map((i: { productId: string; quantity: number }) => [i.productId, i.quantity]),
      );
      expect(quantities).toEqual({ [a.id]: 3, [b.id]: 2 });
      expect(merged.body.data.readyForCheckout).toBe(true);

      const again = await call('post', '/api/v1/cart/merge', customer.accessToken).send(guest).expect(200);
      expect(again.body.data.itemCount).toBe(5);
    });

    it('enforces stock, flags changes and removes lines', async () => {
      const customer = await registerCustomer(app);
      await call('put', `/api/v1/cart/items/${a.id}`, customer.accessToken)
        .send({ quantity: 4 })
        .expect(409);
      await call('put', `/api/v1/cart/items/${a.id}`, customer.accessToken)
        .send({ quantity: 3 })
        .expect(200);
      await call('patch', `/api/v1/vendor/products/${a.id}`, vendor.accessToken)
        .send({ stock: 2 })
        .expect(200);
      const cart = await call('get', '/api/v1/cart', customer.accessToken).expect(200);
      expect(cart.body.data.items[0]).toMatchObject({ issue: 'insufficient_stock', maxQuantity: 2 });
      expect(cart.body.data.readyForCheckout).toBe(false);
      const removed = await call('delete', `/api/v1/cart/items/${a.id}`, customer.accessToken).expect(200);
      expect(removed.body.data.items).toEqual([]);
    });

    it('keeps the cart for customers only', async () => {
      await call('get', '/api/v1/cart', vendor.accessToken).expect(403);
      await call('get', '/api/v1/cart').expect(401);
    });
  });
});
