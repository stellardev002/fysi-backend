import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type EnvVars, NodeEnv, RECEIVED_ENV } from '../config/env.validation.js';
import type { MailMessage, Mailer } from './mailer.js';

/** Development stand-in: prints mail instead of sending it. */
@Injectable()
export class ConsoleMailer implements Mailer {
  private readonly logger = new Logger('Mail');

  constructor(config: ConfigService<EnvVars, true>) {
    if (config.get('NODE_ENV', { infer: true }) !== NodeEnv.Production) return;
    if (!config.get('MAIL_CONSOLE_IN_PRODUCTION', { infer: true })) {
      // Say what arrived, so a missing or mistyped variable is obvious in the logs.
      const raw = RECEIVED_ENV.MAIL_CONSOLE_IN_PRODUCTION;
      throw new Error(
        `No mail provider configured: set RESEND_API_KEY and MAIL_FROM, or MAIL_CONSOLE_IN_PRODUCTION=true on a staging server (MAIL_CONSOLE_IN_PRODUCTION is ${raw === undefined ? 'not set' : JSON.stringify(raw)}; RESEND_API_KEY is ${RECEIVED_ENV.RESEND_API_KEY ? 'set' : 'not set'})`,
      );
    }
    this.logger.warn(
      'MAIL_CONSOLE_IN_PRODUCTION is on: emails, including sign-in codes, are written to the logs instead of being sent',
    );
  }

  send(message: MailMessage): Promise<void> {
    this.logger.log(`To ${message.to}: ${message.subject}\n${message.text}`);
    return Promise.resolve();
  }
}
