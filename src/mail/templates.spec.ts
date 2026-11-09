import { describe, expect, it } from 'vitest';
import { renderEmail } from './templates.js';

const brand = { logoUrl: 'cid:logo', siteUrl: 'https://fysi.ng' };

describe('renderEmail', () => {
  it('escapes user text in the HTML and keeps it readable in the text part', () => {
    const r = renderEmail(
      {
        subject: 'Update',
        preheader: 'p',
        heading: '"<script>alert(1)</script>" was approved',
        paragraphs: ['Line one\nLine two'],
        quote: { label: 'Reviewer’s note', text: '<img src=x onerror=1>' },
        footnote: 'f',
      },
      brand,
    );
    expect(r.html).not.toContain('<script>');
    expect(r.html).not.toContain('<img src=x');
    expect(r.html).toContain('&lt;script&gt;');
    expect(r.html).toContain('Line one<br>Line two');
    expect(r.text).toContain('<img src=x onerror=1>');
  });

  it('shows the code prominently and in the text part', () => {
    const r = renderEmail(
      {
        subject: 's',
        preheader: 'p',
        heading: 'Confirm your email',
        paragraphs: [],
        code: '123456',
        footnote: 'f',
      },
      brand,
    );
    expect(r.html).toContain('>123456<');
    expect(r.text).toMatch(/code is 123456/);
  });

  it('uses the logo when given, else the name in text', () => {
    const content = {
      subject: 's',
      preheader: 'p',
      heading: 'h',
      paragraphs: [],
      footnote: 'f',
    };
    expect(renderEmail(content, brand).html).toContain('src="cid:logo"');
    const plain = renderEmail(content, { logoUrl: '', siteUrl: '' }).html;
    expect(plain).not.toContain('<img');
    expect(plain).toContain('>FYSI</span>');
  });

  it('is responsive and renders a button Outlook can show', () => {
    const r = renderEmail(
      {
        subject: 's',
        preheader: 'p',
        heading: 'h',
        paragraphs: [],
        button: { label: 'Open Fysi', url: 'https://fysi.ng' },
        footnote: 'f',
      },
      brand,
    );
    expect(r.html).toContain('max-width:600px');
    expect(r.html).toMatch(/@media only screen and \(max-width:620px\)/);
    expect(r.html).toContain('<v:roundrect');
    expect(r.html).toContain('class="btn"');
  });
});
