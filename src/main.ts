import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import type { EnvVars } from './config/env.validation.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  configureApp(app);
  const config = app.get<ConfigService<EnvVars, true>>(ConfigService);
  await app.listen(config.get('PORT', { infer: true }), '0.0.0.0');
}
await bootstrap();
