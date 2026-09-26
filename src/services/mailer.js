// Optional SMTP mailer. Password-reset email is sent when SMTP_HOST is set.
// Failures are logged by the caller so a down mailbox never enumerates accounts.
const nodemailer = require('nodemailer');
const env = require('../config/env');

let transporter;

function getTransporter() {
  if (!env.smtpHost) {
    return null;
  }

  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpPort === 465,
      auth: env.smtpUser ? { user: env.smtpUser, pass: env.smtpPass } : undefined
    });
  }

  return transporter;
}

async function sendPasswordResetEmail({ to, resetToken }) {
  const transport = getTransporter();

  if (!transport) {
    return { sent: false };
  }

  const resetUrl = env.appPublicUrl
    ? `${env.appPublicUrl}/reset-password?token=${encodeURIComponent(resetToken)}`
    : null;
  const text = resetUrl
    ? `Reset your MODA password (expires in 1 hour):\n${resetUrl}\n\nIf you did not request this, ignore this email.`
    : `Reset your MODA password. This token expires in 1 hour:\n${resetToken}\n\nIf you did not request this, ignore this email.`;

  await transport.sendMail({
    from: env.smtpFrom,
    to,
    subject: 'Reset your MODA password',
    text
  });

  return { sent: true };
}

module.exports = { sendPasswordResetEmail };
