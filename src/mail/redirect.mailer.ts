import type { MailMessage, Mailer } from './mailer.js';

/**
 * Staging only: delivers every email to one inbox, with the real recipient in
 * the subject. Resend's test sender can only reach the account owner, so this
 * lets anyone register on staging while the codes land in that inbox.
 */
export class RedirectMailer implements Mailer {
  constructor(
    private readonly inner: Mailer,
    private readonly to: string,
  ) {}

  send(message: MailMessage): Promise<void> {
    if (message.to.toLowerCase() === this.to.toLowerCase())
      return this.inner.send(message);
    return this.inner.send({
      ...message,
      to: this.to,
      subject: `[to ${message.to}] ${message.subject}`,
    });
  }
}
