/**
 * Branded Fysi emails, built from one light layout (the logo is dark green).
 * Every email has an HTML part and a plain-text part made from the same content.
 *
 * Email clients only render a narrow subset of HTML: tables for layout, inline
 * styles, no SVG, no `data:` images. The layout is fluid up to 600px and a
 * media query tightens it on phones; Outlook desktop (no max-width, no media
 * queries) gets a fixed 600px table through conditional comments. DM Sans
 * loads where the client allows web fonts and falls back to system fonts.
 * Everything dynamic is escaped, because business names and notes are user text.
 */

/** Fysi style guide, Forest Green scale. Contrast figures are against white. */
export const FOREST = {
  50: '#E6ECE9',
  100: '#B0C3BA',
  200: '#8AA698',
  300: '#547E6A', // 4.60:1 — smallest shade for text on white (AA)
  400: '#33654D', // 6.75:1
  500: '#003E20', // 12.28:1 — primary
  600: '#00381D',
  700: '#002C17',
  800: '#002212',
  900: '#001A0D',
} as const;

/** Lime Yellow scale (accent). Light shades are for fills, never text on white. */
export const LIME = {
  50: '#FCFFE8',
  100: '#F5FFB9',
  200: '#F0FF97',
  300: '#E9FE67',
  400: '#E5FE49',
  500: '#DEFE1C',
  600: '#CAE719',
  700: '#9EB414',
  800: '#7A8C0F', // 3.76:1 on white — large text only
  900: '#5D6B0C', // 5.88:1
} as const;

/** Grey scale (neutrals). */
export const GREY = {
  50: '#FEFFFF',
  100: '#FDFDFE',
  200: '#FCFDFD',
  300: '#FBFCFC',
  400: '#FAFBFC',
  500: '#F9FAFB',
  600: '#E3E4E4',
  700: '#B1B2B2',
  800: '#898A8A',
  900: '#696969', // 5.49:1 on white — smallest grey for text (AA)
} as const;

export const BRAND = {
  primary: FOREST[500],
  onPrimary: '#FFFFFF',
  accent: LIME[500],
  page: GREY[500],
  card: '#FFFFFF',
  border: GREY[600],
  inset: FOREST[50],
  heading: FOREST[800],
  text: FOREST[700],
  muted: GREY[900],
} as const;

// Text and tint per tone; every pair passes WCAG AA. Red and amber are not in
// the style guide; they keep the conventional meaning for problems.
const TONES = {
  success: { fg: FOREST[500], bg: LIME[100] },
  danger: { fg: '#B42318', bg: '#FDECEA' },
  warning: { fg: '#93370D', bg: '#FEF4E6' },
  neutral: { fg: GREY[900], bg: GREY[500] },
  brand: { fg: FOREST[500], bg: FOREST[50] },
} as const;
export type Tone = keyof typeof TONES;

export interface EmailContent {
  subject: string;
  /** Inbox preview line, shown after the subject. */
  preheader: string;
  heading: string;
  status?: { label: string; tone: Tone };
  paragraphs: string[];
  /** A one-time code, shown large. */
  code?: string;
  /** A quoted note, e.g. the reviewer's reason. */
  quote?: { label: string; text: string };
  button?: { label: string; url: string };
  /** Smaller text under the main content. */
  after?: string[];
  /** Why the reader got this email. */
  footnote: string;
}

export interface Brand {
  /** URL of the logo PNG (`cid:` inline); without one the header shows the name in text. */
  logoUrl: string;
  /** The frontend, linked from the footer. */
  siteUrl: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const escape = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Escaped, with line breaks kept. */
const html = (s: string) => escape(s).replace(/\r?\n/g, '<br>');

const FONT =
  "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace";
const TAGLINE = 'Certified eco-friendly products, paid on Stellar.';

export function renderEmail(c: EmailContent, brand: Brand): RenderedEmail {
  return {
    subject: c.subject,
    html: renderHtml(c, brand),
    text: renderText(c, brand),
  };
}

/** One full-width row of the content column. */
const row = (inner: string, padding = '0 0 16px') =>
  `<tr><td style="padding:${padding};">${inner}</td></tr>`;

function renderHtml(c: EmailContent, brand: Brand): string {
  const logo = brand.logoUrl
    ? `<img src="${escape(brand.logoUrl)}" width="109" height="38" alt="Fysi" style="display:block;border:0;outline:none;text-decoration:none;height:38px;width:109px;">`
    : `<span style="font-family:${FONT};font-size:24px;font-weight:700;letter-spacing:1px;color:${BRAND.primary};">FYSI</span>`;

  const status = c.status
    ? row(
        `<span style="display:inline-block;padding:6px 12px;border-radius:999px;background:${TONES[c.status.tone].bg};color:${TONES[c.status.tone].fg};font-family:${FONT};font-size:12px;line-height:14px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;">${escape(c.status.label)}</span>`,
        '0 0 18px',
      )
    : '';

  const heading = `<tr><td class="h1" style="padding:0 0 14px;font-family:${FONT};font-size:26px;line-height:33px;font-weight:700;color:${BRAND.heading};letter-spacing:-0.3px;">${html(c.heading)}</td></tr>`;

  const paragraphs = c.paragraphs
    .map(
      (p) =>
        `<tr><td style="padding:0 0 14px;font-family:${FONT};font-size:16px;line-height:26px;color:${BRAND.text};">${html(p)}</td></tr>`,
    )
    .join('');

  const code = c.code
    ? row(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td align="center" bgcolor="${BRAND.inset}" style="background:${BRAND.inset};border:1px dashed ${BRAND.primary};border-radius:14px;padding:22px 12px 20px;">
            <div style="font-family:${FONT};font-size:12px;line-height:16px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${BRAND.muted};padding-bottom:8px;">Your code</div>
            <div class="code" style="font-family:${MONO};font-size:36px;line-height:42px;font-weight:700;letter-spacing:12px;color:${BRAND.primary};">${escape(c.code)}</div>
          </td>
        </tr></table>`,
        '10px 0 24px',
      )
    : '';

  const quote = c.quote
    ? row(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td width="4" bgcolor="${BRAND.primary}" style="background:${BRAND.primary};border-radius:4px 0 0 4px;font-size:0;line-height:0;">&nbsp;</td>
          <td bgcolor="${BRAND.inset}" style="background:${BRAND.inset};border-radius:0 12px 12px 0;padding:16px 20px;">
            <div style="font-family:${FONT};font-size:12px;line-height:16px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${BRAND.primary};padding-bottom:6px;">${escape(c.quote.label)}</div>
            <div style="font-family:${FONT};font-size:15px;line-height:24px;color:${BRAND.heading};">${html(c.quote.text)}</div>
          </td>
        </tr></table>`,
        '6px 0 22px',
      )
    : '';

  // Bulletproof button: VML for Outlook desktop, a padded link everywhere else.
  const button = c.button
    ? row(
        `<!--[if mso]>
        <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${escape(c.button.url)}" style="height:48px;v-text-anchor:middle;width:240px;" arcsize="25%" stroke="f" fillcolor="${BRAND.primary}">
          <w:anchorlock/>
          <center style="color:${BRAND.onPrimary};font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">${escape(c.button.label)}</center>
        </v:roundrect>
        <![endif]-->
        <!--[if !mso]><!-->
        <table role="presentation" class="btn-table" cellpadding="0" cellspacing="0" border="0"><tr>
          <td align="center" bgcolor="${BRAND.primary}" style="border-radius:12px;">
            <a class="btn" href="${escape(c.button.url)}" target="_blank" style="display:inline-block;padding:14px 30px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:700;color:${BRAND.onPrimary};text-decoration:none;border-radius:12px;">${escape(c.button.label)}&nbsp;&rarr;</a>
          </td>
        </tr></table>
        <!--<![endif]-->`,
        '10px 0 22px',
      )
    : '';

  const after = (c.after ?? [])
    .map(
      (p) =>
        `<tr><td style="padding:0 0 10px;font-family:${FONT};font-size:14px;line-height:22px;color:${BRAND.muted};">${html(p)}</td></tr>`,
    )
    .join('');

  const site = brand.siteUrl
    ? `<a href="${escape(brand.siteUrl)}" target="_blank" style="color:${BRAND.primary};font-weight:700;text-decoration:none;">${escape(brand.siteUrl.replace(/^https?:\/\//, ''))}</a>`
    : '<span style="font-weight:700;">Fysi</span>';

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escape(c.subject)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<!--[if !mso]><!--><link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet"><!--<![endif]-->
<style>
  :root { color-scheme: light; supported-color-schemes: light; }
  body { margin:0 !important; padding:0 !important; width:100% !important; background:${BRAND.page}; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table, td { border-collapse:collapse; mso-table-lspace:0pt; mso-table-rspace:0pt; }
  img { -ms-interpolation-mode:bicubic; }
  a { color:${BRAND.primary}; }
  a[x-apple-data-detectors] { color:inherit !important; text-decoration:none !important; }
  @media only screen and (max-width:620px) {
    .outer { padding:16px 10px 24px !important; }
    .px { padding-left:22px !important; padding-right:22px !important; }
    .head { padding-top:22px !important; padding-bottom:18px !important; }
    .body { padding-top:26px !important; padding-bottom:12px !important; }
    .h1 { font-size:22px !important; line-height:29px !important; }
    .code { font-size:28px !important; line-height:34px !important; letter-spacing:7px !important; }
    .tagline { display:none !important; }
    .btn-table { width:100% !important; }
    .btn { display:block !important; text-align:center !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${BRAND.page};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;color:${BRAND.page};">${escape(c.preheader)}&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.page}" style="background:${BRAND.page};">
  <tr><td align="center" class="outer" style="padding:32px 16px 40px;">
    <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;">
      <tr><td bgcolor="${BRAND.card}" style="background:${BRAND.card};border:1px solid ${BRAND.border};border-radius:18px;overflow:hidden;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td height="6" bgcolor="${BRAND.primary}" style="background:${BRAND.primary};height:6px;font-size:0;line-height:0;">&nbsp;</td></tr>
          <tr><td height="3" bgcolor="${BRAND.accent}" style="background:${BRAND.accent};height:3px;font-size:0;line-height:0;">&nbsp;</td></tr>
          <tr><td class="px head" style="padding:28px 40px 22px;border-bottom:1px solid ${BRAND.border};">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td valign="middle">${logo}</td>
              <td valign="middle" align="right" class="tagline" style="font-family:${FONT};font-size:12px;line-height:16px;font-weight:500;color:${BRAND.muted};">Certified eco-friendly<br>marketplace</td>
            </tr></table>
          </td></tr>
          <tr><td class="px body" style="padding:34px 40px 18px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              ${status}${heading}${paragraphs}${code}${quote}${button}${after}
            </table>
          </td></tr>
          <tr><td class="px" bgcolor="${BRAND.inset}" style="background:${BRAND.inset};padding:20px 40px;border-top:1px solid ${BRAND.border};font-family:${FONT};font-size:13px;line-height:20px;color:${BRAND.text};">
            <span style="color:${BRAND.primary};font-weight:700;">&#127807;&nbsp;${TAGLINE}</span><br>
            Prices in US dollars, paid in USDC, with every payment verifiable on the network.
          </td></tr>
        </table>
      </td></tr>
      <tr><td class="px" style="padding:20px 24px 0;font-family:${FONT};font-size:12px;line-height:19px;color:${BRAND.muted};text-align:center;">
        ${html(c.footnote)}<br>
        ${site} &middot; Lagos &amp; Abuja, Nigeria
      </td></tr>
    </table>
    <!--[if mso]></td></tr></table><![endif]-->
  </td></tr>
</table>
</body>
</html>`;
}

function renderText(c: EmailContent, brand: Brand): string {
  const parts: string[] = [];
  if (c.status) parts.push(`[${c.status.label}]`);
  parts.push(c.heading, '', ...c.paragraphs.flatMap((p) => [p, '']));
  if (c.code) parts.push(`Your code is ${c.code}`, '');
  if (c.quote) parts.push(`${c.quote.label}:`, c.quote.text, '');
  if (c.button) parts.push(`${c.button.label}: ${c.button.url}`, '');
  for (const p of c.after ?? []) parts.push(p, '');
  parts.push('--', c.footnote, TAGLINE);
  parts.push(brand.siteUrl ? `Fysi: ${brand.siteUrl}` : 'Fysi');
  return parts.join('\n');
}
