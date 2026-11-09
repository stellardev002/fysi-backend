import { describe, expect, it } from 'vitest';
import type { MailMessage, Mailer } from './mailer.js';
import { RedirectMailer } from './redirect.mailer.js';

const capture = () => {
  const sent: MailMessage[] = [];
  const inner: Mailer = { send: async (m) => void sent.push(m) };
  return { sent, inner };
};

describe('RedirectMailer', () => {
  it('sends to the redirect inbox and names the real recipient', async () => {
    const { sent, inner } = capture();
    await new RedirectMailer(inner, 'owner@example.com').send({
      to: 'vendor@example.com',
      subject: 'Your code',
      text: 't',
    });
    expect(sent[0]).toMatchObject({
      to: 'owner@example.com',
      subject: '[to vendor@example.com] Your code',
    });
  });

  it('leaves mail to the redirect inbox itself unchanged', async () => {
    const { sent, inner } = capture();
    await new RedirectMailer(inner, 'Owner@example.com').send({
      to: 'owner@example.com',
      subject: 'Your code',
      text: 't',
    });
    expect(sent[0].subject).toBe('Your code');
  });
});
