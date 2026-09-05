const nodemailer = require('nodemailer');

// Any SMTP provider works (Gmail, SendGrid, Mailgun, Resend, Postmark, your
// own mail server, etc.) — configure via env vars in .env.example. Without
// them, sendMail logs the message instead of sending it, so password reset
// still works end-to-end in local dev (check the server console for the link).
function getTransport() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined
  });
}

async function sendMail({ to, subject, text }) {
  const transport = getTransport();
  if (!transport) {
    console.log(`[mailer] SMTP not configured — would have sent to ${to}:\n${subject}\n${text}`);
    return;
  }
  await transport.sendMail({
    from: process.env.SMTP_FROM || 'DocGen AI <no-reply@docgen.app>',
    to,
    subject,
    text
  });
}

module.exports = { sendMail };
