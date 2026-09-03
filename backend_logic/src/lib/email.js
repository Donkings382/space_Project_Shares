import FormData from "form-data";
import Mailgun from "mailgun.js";
import { env } from "../config/env.js";

const mailgun = new Mailgun(FormData);
let mg = null;

if (
  env.nodeEnv !== "test" &&
  process.env.MAILGUN_API_KEY &&
  process.env.MAILGUN_DOMAIN
) {
  mg = mailgun.client({
    username: "api",
    key: process.env.MAILGUN_API_KEY,
  });
}

export async function sendOtpEmail({ to, otp, purpose, userEmail }) {
  const from = process.env.MAILGUN_FROM_EMAIL || "noreply@sandbox.mailgun.org";
  const domain = process.env.MAILGUN_DOMAIN;

  if (!mg || !domain) {
    console.warn("Mailgun not configured; verification email was not sent.");
    return { skipped: true };
  }

  const subject = `Your SpaceX verification code`;
  const html = `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px;">
        <h2 style="margin:0 0 16px;">Verify your email</h2>
        <p style="margin:0 0 12px;">Your verification code is:</p>
        <p style="margin:0 0 12px; font-size:28px; letter-spacing:4px; font-weight:700;">${otp}</p>
        <p style="margin:0;">This code expires in 5 minutes.</p>
      </div>
    `;

  try {
    await mg.messages.create(domain, {
      from,
      to,
      subject,
      html,
      text: `Your verification code is ${otp}. It expires in 5 minutes.`,
    });

    return { sent: true };
  } catch (error) {
    console.warn(
      `Mailgun send failed for ${to}. Error: ${
        error?.response?.body?.message || error?.message || "Unknown error"
      }`,
    );
    return { skipped: true };
  }
}
