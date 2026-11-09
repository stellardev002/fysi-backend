import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../config/env.validation.js';
import { ConsoleMailer } from './console.mailer.js';
import { MailService } from './mail.service.js';
import { Mailer } from './mailer.js';
import { RedirectMailer } from './redirect.mailer.js';
import { ResendMailer } from './resend.mailer.js';

@Global()
@Module({
  providers: [
    {
      provide: Mailer,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>): Mailer => {
        const apiKey = config.get('RESEND_API_KEY', { infer: true });
        if (!apiKey) return new ConsoleMailer(config);
        const from = config.get('MAIL_FROM', { infer: true });
        if (!from) throw new Error('MAIL_FROM is required with RESEND_API_KEY');
        const resend = new ResendMailer(apiKey, from);
        const redirect = config.get('MAIL_REDIRECT_TO', { infer: true });
        return redirect ? new RedirectMailer(resend, redirect) : resend;
      },
    },
    MailService,
  ],
  exports: [MailService],
})
export class MailModule {}
