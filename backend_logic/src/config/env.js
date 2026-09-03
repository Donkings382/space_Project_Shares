import dotenv from "dotenv";

dotenv.config();

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
  allowedOrigins: (
    process.env.ALLOWED_ORIGINS ||
    "http://localhost:3000,http://localhost:5500,null"
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
};
