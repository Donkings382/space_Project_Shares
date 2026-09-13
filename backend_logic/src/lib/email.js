import FormData from "form-data";
import Mailgun from "mailgun.js";
import { env } from "../config/env.js";

const mailgun = new Mailgun(FormData);
let mg = null;

if (env.nodeEnv !== "test" && env.mailgunApiKey && env.mailgunDomain) {
  mg = mailgun.client({
    username: "api",
    key: env.mailgunApiKey,
    url: env.mailgunApiBaseUrl,
  });
}

export async function sendOtpEmail({ to, otp }) {
  const from = env.mailgunFromEmail;
  const domain = env.mailgunDomain;

  if (!mg || !domain) {
    throw new Error("Mailgun is not configured.");
  }

  const subject = "Your SpaceX verification code";
  const html = `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px;">
        <h2 style="margin:0 0 16px;">Verify your SpaceX account</h2>
        <p style="margin:0 0 12px;">Your verification code is:</p>
        <p style="margin:0 0 12px; font-size:28px; letter-spacing:4px; font-weight:700;">${otp}</p>
        <p style="margin:0;">This code expires in 10 minutes.</p>
      </div>
    `;

  try {
    await mg.messages.create(domain, {
      from,
      to,
      subject,
      html,
      text: `Your verification code is ${otp}. It expires in 10 minutes.`,
    });

    return { sent: true };
  } catch (error) {
    console.error(
      `Mailgun send failed for ${to}: ${
        error?.response?.body?.message || error?.message || "Unknown error"
      }`,
    );
    throw error;
  }
}
