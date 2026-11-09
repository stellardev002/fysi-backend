import {
  RequestMethod,
  ValidationPipe,
  VersioningType,
  type INestApplication,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { requestContextMiddleware } from './common/request-context.js';
import type { EnvVars } from './config/env.validation.js';

/** CORS_ORIGINS plus FRONTEND_URL, as exact origins (no paths or trailing slashes). */
export function allowedOrigins(list: string, frontendUrl: string): string[] {
  const all = [...list.split(','), frontendUrl]
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return [...new Set(all)];
}

/** Shared by main.ts and e2e tests so tests run the production pipeline. */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get<ConfigService<EnvVars, true>>(ConfigService);
  const swaggerEnabled = config.get('SWAGGER_ENABLED', { infer: true });

  app.useLogger(app.get(Logger));
  app.set('trust proxy', config.get('TRUST_PROXY_HOPS', { infer: true }));
  app.disable('x-powered-by');

  app.use(requestContextMiddleware);
  // Swagger UI relies on inline scripts, so CSP is relaxed only when it is on.
  app.use(
    helmet({ contentSecurityPolicy: swaggerEnabled ? false : undefined }),
  );

  const origins = allowedOrigins(
    config.get('CORS_ORIGINS', { infer: true }),
    config.get('FRONTEND_URL', { infer: true }),
  );
  app.enableCors({ origin: origins.length > 0 ? origins : false });

  app.useBodyParser('json', { limit: '100kb' });
  // Routes live at /api/v1/...; /health stays bare for the host's health check.
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'health', method: RequestMethod.GET }],
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();

  if (swaggerEnabled)
    setupSwagger(app, config.get('APP_NAME', { infer: true }));
}

function setupSwagger(app: INestApplication, appName: string): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle(`${appName} API`)
      .setVersion('1')
      .setDescription(
        [
          'REST API for Fysi, a marketplace for certified eco-friendly products with payments settled in USDC on Stellar. Verified vendors list products; customers browse and keep a cart without an account, then sign up to buy; admins verify vendors and moderate the catalogue.',
          '',
          '**Machine-readable spec.** The OpenAPI JSON is served at `/docs-json`; feed it to a client generator for typed requests.',
          '',
          '**Responses.** Every success is `{ statusCode, message, data }`. Paginated lists put `{ result, paginationMeta }` in `data`. Errors are `{ statusCode, message, data: null, error: { code, details, requestId, traceId, timestamp, path } }`. Validation errors list each problem in `error.details`.',
          '',
          '**Money.** Prices are US dollars as integer **cents** (`priceCents: 1250` = $12.50); responses add a dollar string. Payment is 1:1 in USDC on Stellar, so there is no exchange rate. No floats.',
          '',
          '**Sign-up and sign-in.** `POST /api/v1/auth/register` (`accountType` customer or vendor), confirm the emailed code at `POST /api/v1/auth/verify-email` to get tokens, then send `Authorization: Bearer <accessToken>`. Refresh tokens are single use: swap them at `POST /api/v1/auth/refresh`.',
          '',
          '**Two-factor sign-in.** Vendors and admins must turn on an authenticator app (`/auth/2fa/setup` then `/auth/2fa/enable`); until then every other route answers 403 `Turn on two-factor sign-in to continue`. With 2FA on, `POST /auth/login` returns an `mfaToken` to finish at `POST /auth/login/2fa`.',
          '',
          '**Admins.** No sign-up: the first super admin is created on the server with `pnpm admin:create`; super admins add admins with `POST /api/v1/admin/users`. Admin sessions idle out after `ADMIN_SESSION_IDLE_MINUTES`. Every admin action goes to the append-only audit log (`GET /api/v1/audit-logs`).',
          '',
          '**Rate limits.** Every route has a per-client limit; sign-in and code routes have a stricter one. A 429 carries a `Retry-After` header in seconds.',
        ].join('\n'),
      )
      .addTag(
        'Auth',
        'Customer and vendor sign-up, email verification, sign-in with two-factor, sessions, password reset and the signed-in account.',
      )
      .addTag(
        'Catalogue',
        'Public, no account: browse, search and filter products, product pages, store pages.',
      )
      .addTag('Categories', 'Product categories for filters and forms.')
      .addTag(
        'Cart',
        'Guest cart pricing, and the customer cart: add, change, remove, merge the guest cart after sign-up.',
      )
      .addTag(
        'Vendor Onboarding',
        'Vendor dashboard: business profile wizard, verification documents, submission and status.',
      )
      .addTag(
        'Vendor Products',
        'Vendor dashboard: create, edit, hide and delete products; photos.',
      )
      .addTag(
        'Admin Vendors',
        'Admin: vendor verification queue, review, approve / reject / suspend / reinstate.',
      )
      .addTag(
        'Admin Catalogue',
        'Admin: product moderation (hide / remove), categories.',
      )
      .addTag(
        'Admin Users',
        'Admin: accounts, suspend and restore, reset 2FA; super admins create admins.',
      )
      .addTag('Audit', 'Admin: append-only activity and audit log.')
      .addTag(
        'Stellar',
        'Network configuration, the settlement asset and read-only account lookups.',
      )
      .addTag('Health', 'Liveness and dependency checks.')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('docs', app, document);
}
