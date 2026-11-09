import { Resend } from 'resend';
import type { MailMessage, Mailer } from './mailer.js';

export class ResendMailer implements Mailer {
  private readonly client: Resend;

  constructor(
    apiKey: string,
    private readonly from: string,
  ) {
    this.client = new Resend(apiKey);
  }

  async send(message: MailMessage): Promise<void> {
    // The SDK reports API failures in `error` instead of throwing.
    const { error } = await this.client.emails.send({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html && { html: message.html }),
      ...(message.inline && { attachments: message.inline }),
    });
    if (error) throw new Error(`Resend: ${error.name}: ${error.message}`);
  }
}
