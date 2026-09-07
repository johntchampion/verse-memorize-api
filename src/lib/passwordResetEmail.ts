/**
 * The reset email's body. A TypeScript template rather than an .html file
 * because the build hand-copies exactly schema.sql and the translation JSON
 * into dist/ — a template file would compile to nothing and fail in the
 * container alone.
 */
export interface EmailBody {
  subject: string
  text: string
  html: string
}

/** Inline styles and a table-free layout: every other approach is a lottery
    across mail clients. */
export function passwordResetEmail(
  resetUrl: string,
  expiresInMinutes: number,
): EmailBody {
  const expiry = `This link expires in ${expiresInMinutes} minutes and can be used once.`

  return {
    subject: 'Reset your Verse Memorize password',
    text: [
      'Someone asked to reset the password for your Verse Memorize account.',
      '',
      'Open this link to choose a new one:',
      resetUrl,
      '',
      expiry,
      '',
      "If this wasn't you, ignore this email — your password stays as it is.",
    ].join('\n'),
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;line-height:1.5;color:#2b2b2b;max-width:520px">
  <p>Someone asked to reset the password for your Verse Memorize account.</p>
  <p style="margin:28px 0">
    <a href="${resetUrl}" style="background:#e2725b;color:#fff;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:16px;display:inline-block">Choose a new password</a>
  </p>
  <p style="color:#6b6b6b;font-size:14px">${expiry}</p>
  <p style="color:#6b6b6b;font-size:14px">If this wasn't you, ignore this email — your password stays as it is.</p>
</div>`,
  }
}
