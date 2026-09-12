import dotenv from "dotenv";

dotenv.config();

const defaultAllowedOrigins = [
  "https://spacexprofit.com",
  "https://www.spacexprofit.com",
  "https://space-project-shares.vercel.app",
  "http://localhost:3000",
  "http://localhost:5500",
  "http://localhost:5501",
  "http://127.0.0.1:5500",
  "http://127.0.0.1:5501",
];
const configuredAllowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

export const env = {
  port: Number(process.env.PORT || 4000),
  nodeEnv: process.env.NODE_ENV || "development",
  jwtSecret: process.env.JWT_SECRET || "dev-secret-change-me",
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5432/spacex",
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY || "",
  paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY || "",
  paystackBaseUrl: process.env.PAYSTACK_BASE_URL || "https://api.paystack.co",
  encryptionKey:
    process.env.ENCRYPTION_KEY || "CHANGE_ME_32_BYTE_KEY_1234567890",
  appDomain: process.env.APP_DOMAIN || "",
  appBaseUrl: process.env.APP_BASE_URL || "http://localhost:3000",
  allowedOrigins: [
    ...new Set([...defaultAllowedOrigins, ...configuredAllowedOrigins]),
  ],
};
