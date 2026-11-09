import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../config/env.validation.js';
import type { VendorDecision } from '../vendors/onboarding.js';
import { type InlineImage, Mailer } from './mailer.js';
import {
  type Brand,
  type EmailContent,
  renderEmail,
  type Tone,
} from './templates.js';

/**
 * The logo travels inside each email as an inline attachment (`cid:`): email
 * clients block SVG and `data:` images, and this needs no public URL.
 */
const LOGO_FILE = resolve('assets/email/logo.png');
const LOGO_CID = 'fysi-logo';

const DECISIONS: Record<
  VendorDecision,
  {
    status: string;
    tone: Tone;
    heading: (name: string) => string;
    lines: string[];
    note: string;
  }
> = {
  approve: {
    status: 'Verified',
    tone: 'success',
    heading: (n) => `${n} is verified`,
    lines: [
      'Good news: your business passed verification. You can now list products on Fysi.',
      'Open your vendor dashboard to add your first product.',
    ],
    note: 'Reviewer’s note',
  },
  reject: {
    status: 'Not approved',
    tone: 'danger',
    heading: (n) => `${n} was not approved yet`,
    lines: [
      'An admin reviewed your application and could not approve it. The note below says what to fix.',
      'Update your business details or documents from the vendor dashboard and submit again.',
    ],
    note: 'What to fix',
  },
  suspend: {
    status: 'Suspended',
    tone: 'danger',
    heading: (n) => `${n} is suspended`,
    lines: [
      'Your store was suspended by the Fysi team, and your products are hidden from customers for now.',
      'Reply to this email if you think this is a mistake.',
    ],
    note: 'Reason',
  },
  reinstate: {
    status: 'Reinstated',
    tone: 'success',
    heading: (n) => `${n} is back on Fysi`,
    lines: [
      'Your store was reinstated. Your active products are visible to customers again.',
    ],
    note: 'Note',
  },
};

const VENDOR_FOOTNOTE =
  'You are receiving this because you have a Fysi vendor account.';

@Injectable()
export class MailService {
  private readonly brand: Brand;
  private readonly inline: InlineImage[];

  constructor(
    private readonly mailer: Mailer,
    config: ConfigService<EnvVars, true>,
  ) {
    const site = config
      .get('FRONTEND_URL', { infer: true })
      .replace(/\/+$/, '');
    // Without the file the header falls back to the name in text.
    const logo = existsSync(LOGO_FILE) ? readFileSync(LOGO_FILE) : null;
    this.inline = logo
      ? [{ filename: 'logo.png', content: logo, contentId: LOGO_CID }]
      : [];
    this.brand = { siteUrl: site, logoUrl: logo ? `cid:${LOGO_CID}` : '' };
  }

  sendVerificationCode(
    to: string,
    code: string,
    ttlMinutes: number,
  ): Promise<void> {
    return this.send(to, {
      subject: 'Your Fysi verification code',
      preheader: `Your code is ${code}. It expires in ${ttlMinutes} minutes.`,
      heading: 'Confirm your email',
      paragraphs: ['Enter this code to finish creating your Fysi account.'],
      code,
      after: [`The code expires in ${ttlMinutes} minutes.`],
      footnote: 'If you did not sign up for Fysi, you can ignore this email.',
    });
  }

  sendPasswordResetCode(
    to: string,
    code: string,
    ttlMinutes: number,
  ): Promise<void> {
    return this.send(to, {
      subject: 'Reset your Fysi password',
      preheader: `Your password reset code is ${code}.`,
      heading: 'Reset your password',
      paragraphs: [
        'Enter this code on the reset page to choose a new password.',
      ],
      code,
      after: [
        `The code expires in ${ttlMinutes} minutes. Resetting signs you out on every device.`,
      ],
      footnote:
        'If you did not ask to reset your password, ignore this email: your password stays the same.',
    });
  }

  sendAdminInvite(to: string, code: string, ttlMinutes: number): Promise<void> {
    return this.send(to, {
      subject: 'You are now a Fysi admin',
      preheader: 'Choose your password to sign in to the admin console.',
      heading: 'Welcome to the admin team',
      status: { label: 'Admin access', tone: 'brand' },
      paragraphs: [
        'A super admin created a Fysi admin account for you.',
        'To choose your password, open the reset password page, enter this email address and the code below. You will then set up two-factor sign-in with an authenticator app.',
      ],
      code,
      after: [
        `The code expires in ${ttlMinutes} minutes. After that, use "Forgot password" to get a new one.`,
      ],
      footnote: 'If you were not expecting this, reply to let the team know.',
    });
  }

  /** Verification decisions on a vendor business (PRD V3). */
  sendVendorDecision(
    to: string,
    businessName: string,
    decision: VendorDecision,
    reason: string | null,
  ): Promise<void> {
    const d = DECISIONS[decision];
    return this.send(to, {
      subject: `Fysi: ${d.status.toLowerCase()} — ${businessName}`,
      preheader: d.lines[0],
      heading: d.heading(businessName),
      status: { label: d.status, tone: d.tone },
      paragraphs: d.lines,
      quote: reason ? { label: d.note, text: reason } : undefined,
      button: this.dashboardButton(),
      footnote: VENDOR_FOOTNOTE,
    });
  }

  /** PRD C7: order confirmation with the transaction hash. */
  sendOrderConfirmation(
    to: string,
    o: { number: string; totalUsd: string; lines: string[]; txHash: string; explorerUrl: string },
  ): Promise<void> {
    return this.send(to, {
      subject: `Fysi: order ${o.number} is paid`,
      preheader: `We received $${o.totalUsd} in USDC for order ${o.number}.`,
      heading: `Order ${o.number} is confirmed`,
      status: { label: 'Paid', tone: 'success' },
      paragraphs: [
        `We received your payment of $${o.totalUsd} (USDC on Stellar). Your vendors have been told and will ship soon.`,
        o.lines.join('\n'),
      ],
      quote: { label: 'Transaction hash', text: `${o.txHash}\n${o.explorerUrl}` },
      button: this.siteButton('Track your order', `/account/orders`),
      after: [
        'Your money is held safely until you confirm delivery, or 7 days after shipping.',
      ],
      footnote: 'You are receiving this because you placed an order on Fysi.',
    });
  }

  /** PRD V9: email on each paid order. */
  sendVendorNewOrder(
    to: string,
    o: { number: string; payoutUsd: string; lines: string[] },
  ): Promise<void> {
    return this.send(to, {
      subject: `Fysi: new paid order ${o.number}`,
      preheader: `You have a new paid order. $${o.payoutUsd} is waiting for you in escrow.`,
      heading: `New order ${o.number}`,
      status: { label: 'Paid', tone: 'success' },
      paragraphs: [
        'A customer paid for the items below. Pack them, ship them and add the tracking number in your dashboard.',
        o.lines.join('\n'),
        `$${o.payoutUsd} (after commission) shows as pending in your wallet and is released when the customer confirms delivery, or 7 days after you mark it shipped.`,
      ],
      button: this.siteButton('Open the order', '/vendor/orders'),
      footnote: VENDOR_FOOTNOTE,
    });
  }

  sendOrderShipped(
    to: string,
    o: { number: string; vendorName: string; carrier: string | null; trackingNumber: string },
  ): Promise<void> {
    return this.send(to, {
      subject: `Fysi: ${o.vendorName} shipped part of order ${o.number}`,
      preheader: `Tracking number ${o.trackingNumber}.`,
      heading: 'Your items are on the way',
      status: { label: 'Shipped', tone: 'brand' },
      paragraphs: [`${o.vendorName} shipped your items from order ${o.number}.`],
      quote: {
        label: 'Tracking',
        text: o.carrier ? `${o.carrier}: ${o.trackingNumber}` : o.trackingNumber,
      },
      button: this.siteButton('Track your order', '/account/orders'),
      after: ['When everything arrives, tap "Confirm delivery" so the vendor gets paid.'],
      footnote: 'You are receiving this because you placed an order on Fysi.',
    });
  }

  sendWithdrawalCode(
    to: string,
    code: string,
    ttlMinutes: number,
    w: { amountUsd: string; destination: string },
  ): Promise<void> {
    return this.send(to, {
      subject: 'Confirm your Fysi withdrawal',
      preheader: `Your code is ${code}. Withdrawal of $${w.amountUsd}.`,
      heading: 'Confirm your withdrawal',
      status: { label: 'Action needed', tone: 'warning' },
      paragraphs: [
        `Enter this code with your password to send ${w.amountUsd} USDC to ${w.destination}.`,
      ],
      code,
      after: [`The code expires in ${ttlMinutes} minutes.`],
      footnote:
        'If you did not ask for this withdrawal, change your password now and contact Fysi support: someone may know it.',
    });
  }

  private siteButton(label: string, path: string) {
    return this.brand.siteUrl ? { label, url: `${this.brand.siteUrl}${path}` } : undefined;
  }

  private dashboardButton() {
    return this.brand.siteUrl
      ? { label: 'Open Fysi', url: this.brand.siteUrl }
      : undefined;
  }

  private send(to: string, content: EmailContent): Promise<void> {
    const { subject, html, text } = renderEmail(content, this.brand);
    return this.mailer.send({ to, subject, text, html, inline: this.inline });
  }
}
