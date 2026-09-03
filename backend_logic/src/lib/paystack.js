import axios from "axios";
import { env } from "../config/env.js";

const client = axios.create({
  baseURL: env.paystackBaseUrl,
  headers: {
    Authorization: `Bearer ${env.paystackSecretKey}`,
    "Content-Type": "application/json",
  },
  timeout: 15000,
});

export async function initPaystackTransaction({
  email,
  amount,
  reference,
  planCode,
  metadata,
}) {
  if (!env.paystackSecretKey) {
    throw new Error("Paystack secret key is not configured.");
  }

  const response = await client.post("/transaction/initialize", {
    email,
    amount: Number(amount) * 100,
    reference,
    callback_url: `${env.appBaseUrl}/billing/verify`,
    plan: planCode,
    metadata: metadata || {},
  });

  return response.data.data;
}

export async function verifyPaystackTransaction(reference) {
  if (!env.paystackSecretKey) {
    throw new Error("Paystack secret key is not configured.");
  }

  const response = await client.get(`/transaction/verify/${reference}`);
  return response.data.data;
}
