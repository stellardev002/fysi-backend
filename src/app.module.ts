import { createRequire } from 'node:module';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { JwtAuthGuard } from './auth/jwt-auth.guard.js';
import { AuthorizationModule } from './authorization/authorization.module.js';
import { CategoriesModule } from './categories/categories.module.js';
import { PoliciesGuard, RolesGuard } from './authorization/guards.js';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { getRequestContext } from './common/request-context.js';
import { ResponseInterceptor } from './common/response.js';
import { type EnvVars, NodeEnv, validateEnv } from './config/env.validation.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { MailModule } from './mail/mail.module.js';
import { RateLimitGuard } from './rate-limit/rate-limit.guard.js';
import { RateLimitModule } from './rate-limit/rate-limit.module.js';
import { RedisModule } from './redis/redis.module.js';
import { StellarModule } from './stellar/stellar.module.js';
import { StorageModule } from './storage/storage.module.js';
import { UsersModule } from './users/users.module.js';
import { CartModule } from './cart/cart.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { WalletsModule } from './wallets/wallets.module.js';
import { SecretBoxModule } from './common/secret-box.module.js';
import { ProductsModule } from './products/products.module.js';
import { VendorsModule } from './vendors/vendors.module.js';
import { AnalyticsModule } from './analytics/analytics.module.js';
import { MarketingModule } from './marketing/marketing.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { PromotionsModule } from './promotions/promotions.module.js';
import { ReviewsModule } from './reviews/reviews.module.js';
import { StorefrontModule } from './storefront/storefront.module.js';
import { SupportModule } from './support/support.module.js';

const isInstalled = (pkg: string): boolean => {
  try {
    createRequire(import.meta.url).resolve(pkg);
    return true;
  } catch {
    return false;
  }
};

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>) => {
        // pino-pretty is a dev dependency, absent from the production image.
        const pretty =
          config.get('NODE_ENV', { infer: true }) !== NodeEnv.Production &&
          isInstalled('pino-pretty');
        return {
          pinoHttp: {
            level: config.get('LOG_LEVEL', { infer: true }),
            genReqId: (req) => (req as unknown as { id: string }).id,
            mixin: () => {
              const ctx = getRequestContext();
              return ctx
                ? {
                    requestId: ctx.requestId,
                    traceId: ctx.traceId,
                    userId: ctx.userId,
                  }
                : {};
            },
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
              // Drizzle errors carry bound query params (password hashes).
              'err.params',
              'err.cause.params',
            ],
            serializers: {
              req: (req: { method: string; url: string }) => ({
                method: req.method,
                url: req.url.split('?')[0],
              }),
              res: (res: { statusCode: number }) => ({
                statusCode: res.statusCode,
              }),
            },
            customSuccessMessage: (req, res, ms) =>
              `${req.method} ${req.url?.split('?')[0]} ${res.statusCode} ${Math.round(ms)}ms`,
            customErrorMessage: (req, res) =>
              `${req.method} ${req.url?.split('?')[0]} ${res.statusCode} failed`,
            customLogLevel: (_req, res, err) =>
              err || res.statusCode >= 500
                ? 'error'
                : res.statusCode >= 400
                  ? 'warn'
                  : 'info',
            // JSON in production; human-readable elsewhere.
            transport: pretty
              ? {
                  target: 'pino-pretty',
                  options: {
                    colorize: true,
                    singleLine: true,
                    translateTime: 'SYS:HH:MM:ss.l',
                    ignore: 'pid,hostname,req,res,responseTime,requestId',
                    messageFormat: '{if requestId}[{requestId}] {end}{msg}',
                  },
                }
              : undefined,
          },
        };
      },
    }),
    DatabaseModule,
    SecretBoxModule,
    RedisModule,
    MailModule,
    StorageModule,
    RateLimitModule,
    NotificationsModule,
    AuthModule,
    AuthorizationModule,
    AuditModule,
    UsersModule,
    StellarModule,
    CategoriesModule,
    VendorsModule,
    ProductsModule,
    CartModule,
    WalletsModule,
    PaymentsModule,
    OrdersModule,
    StorefrontModule,
    ReviewsModule,
    PromotionsModule,
    SupportModule,
    MarketingModule,
    AnalyticsModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    // Order matters: authenticate, then rate limit by user, then authorise.
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
    { provide: APP_GUARD, useExisting: RateLimitGuard },
    { provide: APP_GUARD, useExisting: RolesGuard },
    { provide: APP_GUARD, useExisting: PoliciesGuard },
  ],
})
export class AppModule {}
