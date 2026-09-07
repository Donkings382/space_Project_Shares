import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient({
  log:
    process.env.NODE_ENV === "development"
      ? ["query", "error", "warn"]
      : ["error"],
});

async function ensureSignupOtpTable() {
  try {
    await prisma.$queryRaw`SELECT 1 FROM "SignupOtp" LIMIT 1;`;
  } catch (error) {
    const message = String(error.message || "").toLowerCase();
    if (
      message.includes("does not exist") ||
      message.includes("relation") ||
      message.includes('"signupotp"')
    ) {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "SignupOtp" (
          "id" TEXT NOT NULL,
          "userId" TEXT,
          "email" TEXT NOT NULL,
          "otp" TEXT NOT NULL,
          "purpose" TEXT NOT NULL DEFAULT 'signup',
          "expiresAt" TIMESTAMP(3) NOT NULL,
          "usedAt" TIMESTAMP(3),
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "SignupOtp_pkey" PRIMARY KEY ("id")
        );
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "SignupOtp_email_idx"
        ON "SignupOtp"("email");
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "SignupOtp_userId_idx"
        ON "SignupOtp"("userId");
      `);
      return;
    }
    throw error;
  }
}

export async function connectDatabase() {
  try {
    await prisma.$connect();
    console.log("Database connected successfully");
    await ensureSignupOtpTable();
  } catch (error) {
    console.error("Failed to connect to database", error);
    process.exit(1);
  }
}
