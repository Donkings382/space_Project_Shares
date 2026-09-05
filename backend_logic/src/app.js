import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { env } from "./config/env.js";
import { prisma } from "./config/db.js";
import { authenticateToken, requireRole } from "./middleware/auth.js";
import { errorHandler } from "./middleware/errorHandler.js";
import {
  encryptSensitiveValue,
  decryptSensitiveValue,
} from "./lib/encryption.js";
import {
  initPaystackTransaction,
  verifyPaystackTransaction,
} from "./lib/paystack.js";
import { processKycUpload, removeKycFile } from "./lib/kyc.js";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { sendOtpEmail } from "./lib/email.js";
import crypto from "node:crypto";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.join(__dirname, "../uploads");

await fs.mkdir(uploadsDir, { recursive: true });

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 5 * 1024 * 1024 },
});

app.use(
  cors({
    origin: (origin, callback) => {
      const allowed =
        !origin || env.allowedOrigins.includes(origin) || origin === "null";

      callback(null, allowed);
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: "2mb" }));

const registerSchema = z.object({
  name: z.string().min(2),
  username: z
    .string()
    .trim()
    .min(3)
    .max(60)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .optional(),
  email: z.string().email(),
  password: z.string().min(8),
  recoveryContact: z.string().trim().max(254).optional(),
});

const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(8),
});

const verifyOtpSchema = z.object({
  email: z.string().email(),
  otp: z.string().min(6).max(6),
});

const passwordResetRequestSchema = z.object({
  recoveryContact: z.string().trim().min(1).max(254),
});

const passwordResetVerifySchema = z.object({
  recoveryContact: z.string().trim().min(1).max(254),
  otp: z.string().length(6),
});

const passwordResetCompleteSchema = passwordResetVerifySchema.extend({
  password: z.string().min(8),
  confirmPassword: z.string().min(8),
});

const sensitiveSchema = z.object({
  bankName: z.string().optional(),
  accountNumber: z.string().optional(),
  routingNumber: z.string().optional(),
  ssn: z.string().optional(),
  provider: z.string().optional(),
  accountNumber401k: z.string().optional(),
  notes: z.string().optional(),
});

const profileSchema = z.object({
  name: z.string().trim().min(2).max(120),
});

const planSchema = z.object({
  code: z.string().min(2),
  name: z.string().min(2),
  amount: z.number().positive(),
  interval: z.string().min(2),
  description: z.string().optional(),
});

const adminBalanceSchema = z.object({
  amount: z.number().positive(),
  reason: z.enum([
    "Adjustment",
    "Correction",
    "Compensation",
    "Penalty",
    "Fraud remediation",
    "Manual override",
  ]),
  note: z.string().min(1),
});

const depositCompletionSchema = z.object({
  amount: z.number().positive(),
  method: z.enum([
    "bank",
    "crypto",
    "cashapp",
    "zelle",
    "venmo",
    "paypal",
    "moneygram",
    "gift",
  ]),
  note: z.string().trim().max(500).optional(),
});

const retirementAccountSchema = z.object({
  provider: z.string().trim().min(2).max(120),
  legalName: z.string().trim().min(2).max(120),
  username: z.string().trim().max(120).optional(),
  accountNumber: z.string().trim().max(80).optional(),
  ssn: z.string().trim().max(32).optional(),
  bankName: z.string().trim().min(2).max(120),
  routingNumber: z
    .string()
    .regex(/^\d{9}$/, "Routing number must contain exactly 9 digits"),
  accountType: z.enum(["Checking", "Savings"]),
  accountHolderName: z.string().trim().min(2).max(120),
  bankConsent: z.literal(true),
  planType: z.string().trim().max(120).optional(),
  balance: z.number().nonnegative().optional(),
  contributionPct: z.number().min(0).max(100).optional(),
});

const kycProfileSchema = z.object({
  legalName: z.string().trim().min(2).max(120),
  dob: z.string().trim().min(4).max(32),
  nationality: z.string().trim().min(2).max(80),
  address: z.string().trim().min(5).max(300),
  phoneCode: z.string().trim().max(12).optional(),
  phone: z.string().trim().min(3).max(40),
  idType: z.string().trim().min(2).max(40),
  idNumber: z.string().trim().min(2).max(80),
});

function maskValue(value, visible = 4) {
  if (!value) return null;
  const text = String(value);
  return "•".repeat(Math.max(0, text.length - visible)) + text.slice(-visible);
}

async function readStoredImage(document) {
  if (
    !document?.storagePath ||
    document.storagePath === "REJECTED_AND_DELETED" ||
    document.storagePath === "DELETED"
  ) {
    return null;
  }

  try {
    const image = await fs.readFile(document.storagePath);
    return `data:${document.mimeType};base64,${image.toString("base64")}`;
  } catch {
    return null;
  }
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    env.jwtSecret,
    {
      expiresIn: "7d",
    },
  );
}

function sanitizeUser(user) {
  const kycProfile = user.kycProfile
    ? {
        legalName: user.kycProfile.legalName,
        dob: user.kycProfile.dob,
        nationality: user.kycProfile.nationality,
        address: user.kycProfile.address,
        phoneCode: user.kycProfile.phoneCode,
        phone: user.kycProfile.phone,
        idType: user.kycProfile.idType,
        status: user.kycProfile.status,
        submittedAt: user.kycProfile.submittedAt,
        updatedAt: user.kycProfile.updatedAt,
        reviewedAt: user.kycProfile.reviewedAt,
        reviewedBy: user.kycProfile.reviewedBy,
        rejectionReason: user.kycProfile.rejectionReason,
      }
    : null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    verified: user.verified === true,
    createdAt: user.createdAt,
    kycDocuments: (user.kycDocuments || []).map((document) => ({
      id: document.id,
      docType: document.docType,
      fileName: document.fileName,
      mimeType: document.mimeType,
      status: document.status,
      rejectionReason: document.rejectionReason,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    })),
    subscriptions: user.subscriptions || [],
    retirementAccount: user.retirementAccount || null,
    kycProfile,
  };
}

function generateOtp() {
  return crypto.randomInt(100000, 1000000).toString();
}

function hashOtp(otp) {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

const bypassEmailOtp =
  String(process.env.BYPASS_EMAIL_OTP || "false").toLowerCase() === "true";

function getAdminEmail() {
  return (process.env.ADMIN_EMAIL || "admin@yourdomain.com").trim();
}

async function dispatchSignupOtp(email, userId) {
  const otp = bypassEmailOtp ? "000000" : generateOtp();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  await prisma.signupOtp.updateMany({
    where: { userId, purpose: "signup", usedAt: null },
    data: { usedAt: new Date() },
  });

  await prisma.signupOtp.create({
    data: {
      userId,
      email: email.toLowerCase(),
      otp: hashOtp(otp),
      purpose: "signup",
      expiresAt,
    },
  });

  if (bypassEmailOtp) {
    return otp;
  }

  await sendOtpEmail({
    to: email,
    otp,
    purpose: "signup",
    userEmail: email,
  });

  return otp;
}

app.get("/health", (req, res) => {
  res.json({ ok: true, message: "SpaceX backend is running" });
});

app.post("/api/auth/register", async (req, res, next) => {
  try {
    const parsed = registerSchema.parse(req.body);

    const email = parsed.email.toLowerCase();
    const existing = await prisma.user.findUnique({
      where: { email },
    });
    if (existing) {
      return res.status(409).json({ message: "User already exists." });
    }

    const passwordHash = await bcrypt.hash(parsed.password, 12);
    const user = await prisma.user.create({
      data: {
        name: parsed.name,
        username: parsed.username || null,
        email,
        recoveryContact: parsed.recoveryContact || null,
        passwordHash,
        role: "USER",
        isActive: bypassEmailOtp,
      },
    });

    await dispatchSignupOtp(email, user.id);

    return res.status(201).json({
      message: bypassEmailOtp
        ? "Account created. Local testing mode is active; no email OTP is required."
        : "Verification code sent to your email.",
      user: sanitizeUser(user),
      otpBypass: bypassEmailOtp,
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/auth/verify-email", async (req, res, next) => {
  try {
    const parsed = verifyOtpSchema.parse(req.body);

    const email = parsed.email.toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    if (bypassEmailOtp) {
      await prisma.user.update({
        where: { email },
        data: { isActive: true },
      });

      const token = signToken(user);

      return res.json({
        message: "Local testing mode: email verification bypassed.",
        token,
        user: sanitizeUser({ ...user, isActive: true }),
      });
    }

    const otpRecord = await prisma.signupOtp.findFirst({
      where: {
        email,
        otp: hashOtp(parsed.otp),
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });

    if (!otpRecord) {
      return res
        .status(400)
        .json({ message: "Invalid or expired verification code." });
    }

    const updatedUser = await prisma.user.update({
      where: { email },
      data: {
        isActive: true,
      },
    });

    await prisma.signupOtp.update({
      where: { id: otpRecord.id },
      data: { usedAt: new Date() },
    });

    const token = signToken(updatedUser);

    return res.json({
      message: "Email verified successfully.",
      token,
      user: sanitizeUser(updatedUser),
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/auth/resend-otp", async (req, res, next) => {
  try {
    const parsed = z.object({ email: z.string().email() }).parse(req.body);
    const email = parsed.email.toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    if (user.isActive) {
      return res
        .status(400)
        .json({ message: "This account is already verified." });
    }

    await dispatchSignupOtp(email, user.id);

    return res.json({
      message: "A new verification code has been sent to your email.",
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/auth/password-reset/request", async (req, res, next) => {
  try {
    const parsed = passwordResetRequestSchema.parse(req.body);
    const recoveryContact = parsed.recoveryContact.toLowerCase();
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: recoveryContact },
          { recoveryContact: parsed.recoveryContact },
        ],
      },
    });

    if (!user) {
      return res.json({
        message: "If the account exists, a reset code has been sent.",
      });
    }

    const otp = bypassEmailOtp ? "000000" : generateOtp();
    await prisma.signupOtp.updateMany({
      where: { userId: user.id, purpose: "password_reset", usedAt: null },
      data: { usedAt: new Date() },
    });
    await prisma.signupOtp.create({
      data: {
        userId: user.id,
        email: user.email,
        otp: hashOtp(otp),
        purpose: "password_reset",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    if (!bypassEmailOtp) {
      await sendOtpEmail({
        to: user.email,
        otp,
        purpose: "password reset",
        userEmail: user.email,
      });
    }

    return res.json({
      message: "If the account exists, a reset code has been sent.",
      otpBypass: bypassEmailOtp,
      ...(bypassEmailOtp ? { otp } : {}),
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/auth/password-reset/verify", async (req, res, next) => {
  try {
    const parsed = passwordResetVerifySchema.parse(req.body);
    const identifier = parsed.recoveryContact.toLowerCase();
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: identifier },
          { recoveryContact: parsed.recoveryContact },
        ],
      },
    });
    const record = user
      ? await prisma.signupOtp.findFirst({
          where: {
            userId: user.id,
            purpose: "password_reset",
            otp: hashOtp(parsed.otp),
            usedAt: null,
            expiresAt: { gt: new Date() },
          },
          orderBy: { createdAt: "desc" },
        })
      : null;

    if (!record)
      return res
        .status(400)
        .json({ message: "Invalid or expired reset code." });
    return res.json({ message: "Reset code verified." });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/auth/password-reset/complete", async (req, res, next) => {
  try {
    const parsed = passwordResetCompleteSchema.parse(req.body);
    if (parsed.password !== parsed.confirmPassword) {
      return res.status(400).json({ message: "Passwords do not match." });
    }

    const identifier = parsed.recoveryContact.toLowerCase();
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: identifier },
          { recoveryContact: parsed.recoveryContact },
        ],
      },
    });
    const record = user
      ? await prisma.signupOtp.findFirst({
          where: {
            userId: user.id,
            purpose: "password_reset",
            otp: hashOtp(parsed.otp),
            usedAt: null,
            expiresAt: { gt: new Date() },
          },
          orderBy: { createdAt: "desc" },
        })
      : null;

    if (!user || !record) {
      return res
        .status(400)
        .json({ message: "Invalid or expired reset code." });
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await bcrypt.hash(parsed.password, 12) },
      }),
      prisma.signupOtp.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
    ]);

    return res.json({ message: "Password updated successfully." });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const parsed = loginSchema.parse(req.body);
    const identifier = parsed.identifier.toLowerCase();
    const user = await prisma.user.findUnique({
      where: { email: identifier },
    });

    const userByUsername = user
      ? user
      : await prisma.user.findUnique({
          where: { username: identifier },
        });

    if (!userByUsername) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    if (!userByUsername.isActive) {
      return res
        .status(403)
        .json({ message: "Please verify your email before signing in." });
    }

    const passwordMatches = await bcrypt.compare(
      parsed.password,
      userByUsername.passwordHash,
    );
    if (!passwordMatches) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    const token = signToken(userByUsername);
    return res.json({ token, user: sanitizeUser(userByUsername) });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/me", authenticateToken, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        subscriptions: true,
        retirementAccount: true,
        kycDocuments: true,
        kycProfile: true,
      },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    return res.json({ user: sanitizeUser(user) });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/me/transactions", authenticateToken, async (req, res, next) => {
  try {
    const transactions = await prisma.transaction.findMany({
      where: { userId: req.user.id, deletedAt: null },
      orderBy: { createdAt: "desc" },
    });
    return res.json({ transactions });
  } catch (error) {
    return next(error);
  }
});

app.post(
  "/api/me/transactions/deposit",
  authenticateToken,
  async (req, res, next) => {
    try {
      const parsed = depositCompletionSchema.parse(req.body);
      const transaction = await prisma.transaction.create({
        data: {
          userId: req.user.id,
          type: "deposit",
          amount: parsed.amount,
          status: "COMPLETED",
          description: `${parsed.method} deposit`,
          metadata: { method: parsed.method, note: parsed.note || null },
        },
      });
      return res.status(201).json({ transaction });
    } catch (error) {
      return next(error);
    }
  },
);

app.patch("/api/me", authenticateToken, async (req, res, next) => {
  try {
    const parsed = profileSchema.parse(req.body);
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { name: parsed.name },
    });

    return res.json({ message: "Profile updated.", user: sanitizeUser(user) });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/kyc/me", authenticateToken, async (req, res, next) => {
  try {
    const profile = await prisma.kycProfile.findUnique({
      where: { userId: req.user.id },
      select: {
        legalName: true,
        dob: true,
        nationality: true,
        address: true,
        phoneCode: true,
        phone: true,
        idType: true,
        status: true,
        submittedAt: true,
        updatedAt: true,
      },
    });
    const documents = await prisma.kycDocument.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        docType: true,
        fileName: true,
        mimeType: true,
        status: true,
        rejectionReason: true,
        ocrText: true,
        confidence: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return res.json({ profile, documents });
  } catch (error) {
    return next(error);
  }
});

app.delete("/api/kyc/me", authenticateToken, async (req, res, next) => {
  try {
    const documents = await prisma.kycDocument.findMany({
      where: { userId: req.user.id },
      select: { id: true, storagePath: true },
    });
    await Promise.all(
      documents.map((document) => removeKycFile(document.storagePath)),
    );
    await prisma.$transaction([
      prisma.kycDocument.deleteMany({ where: { userId: req.user.id } }),
      prisma.kycProfile.deleteMany({ where: { userId: req.user.id } }),
      prisma.user.update({
        where: { id: req.user.id },
        data: { verified: false },
      }),
      prisma.auditLog.create({
        data: {
          userId: req.user.id,
          actorId: req.user.id,
          action: "KYC_USER_DELETED",
        },
      }),
    ]);
    return res.json({ message: "Your KYC data was deleted." });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/kyc/profile", authenticateToken, async (req, res, next) => {
  try {
    const parsed = kycProfileSchema.parse(req.body);
    const profile = await prisma.kycProfile.upsert({
      where: { userId: req.user.id },
      update: {
        legalName: parsed.legalName,
        dob: parsed.dob,
        nationality: parsed.nationality,
        address: parsed.address,
        phoneCode: parsed.phoneCode || null,
        phone: parsed.phone,
        idType: parsed.idType,
        idNumberEncrypted: parsed.idNumber
          ? encryptSensitiveValue(parsed.idNumber)
          : undefined,
        status: "PENDING",
        reviewedAt: null,
        reviewedBy: null,
        rejectionReason: null,
      },
      create: {
        userId: req.user.id,
        legalName: parsed.legalName,
        dob: parsed.dob,
        nationality: parsed.nationality,
        address: parsed.address,
        phoneCode: parsed.phoneCode || null,
        phone: parsed.phone,
        idType: parsed.idType,
        idNumberEncrypted: parsed.idNumber
          ? encryptSensitiveValue(parsed.idNumber)
          : null,
        status: "PENDING",
        reviewedAt: null,
        reviewedBy: null,
        rejectionReason: null,
      },
    });
    await prisma.user.update({
      where: { id: req.user.id },
      data: { verified: false },
    });
    return res.status(202).json({ message: "KYC profile submitted.", profile });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/sensitive-data", authenticateToken, async (req, res, next) => {
  try {
    const parsed = sensitiveSchema.parse(req.body);

    const payload = {
      userId: req.user.id,
      bankNameEncrypted: parsed.bankName
        ? encryptSensitiveValue(parsed.bankName)
        : null,
      accountNumberEncrypted: parsed.accountNumber
        ? encryptSensitiveValue(parsed.accountNumber)
        : null,
      routingNumberEncrypted: parsed.routingNumber
        ? encryptSensitiveValue(parsed.routingNumber)
        : null,
      ssnEncrypted: parsed.ssn ? encryptSensitiveValue(parsed.ssn) : null,
      k401kProviderEncrypted: parsed.provider
        ? encryptSensitiveValue(parsed.provider)
        : null,
      k401kNumberEncrypted: parsed.accountNumber401k
        ? encryptSensitiveValue(parsed.accountNumber401k)
        : null,
      notes: parsed.notes || null,
    };

    const existing = await prisma.userSensitiveData.findUnique({
      where: { userId: req.user.id },
    });
    const record = existing
      ? await prisma.userSensitiveData.update({
          where: { userId: req.user.id },
          data: payload,
        })
      : await prisma.userSensitiveData.create({ data: payload });

    return res.status(201).json({ message: "Sensitive data stored.", record });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/sensitive-data/me", authenticateToken, async (req, res, next) => {
  try {
    const record = await prisma.userSensitiveData.findUnique({
      where: { userId: req.user.id },
    });
    if (!record) {
      return res.status(404).json({ message: "No sensitive data found." });
    }

    return res.json({
      bankName: decryptSensitiveValue(record.bankNameEncrypted),
      accountNumber: decryptSensitiveValue(record.accountNumberEncrypted),
      routingNumber: decryptSensitiveValue(record.routingNumberEncrypted),
      ssn: decryptSensitiveValue(record.ssnEncrypted),
      provider: decryptSensitiveValue(record.k401kProviderEncrypted),
      accountNumber401k: decryptSensitiveValue(record.k401kNumberEncrypted),
      notes: record.notes,
    });
  } catch (error) {
    return next(error);
  }
});

app.post(
  "/api/kyc/upload",
  authenticateToken,
  upload.single("document"),
  async (req, res, next) => {
    try {
      const rawDocType = String(req.body.docType || "");
      const is401kDocument = rawDocType.toLowerCase().startsWith("401k_");
      const normalizedRawDocType = is401kDocument
        ? rawDocType.slice("401k_".length)
        : rawDocType;
      const baseDocType = normalizedRawDocType
        .replace(/_(front|back)$/i, "")
        .toLowerCase();
      const normalizedDocType =
        { license: "drivers_license" }[baseDocType] || baseDocType;
      const docType = is401kDocument
        ? `401k_${normalizedDocType}`
        : normalizedDocType;
      if (!req.file) {
        return res.status(400).json({ message: "No document uploaded." });
      }

      const result = await processKycUpload({
        filePath: req.file.path,
        docType,
        mimeType: req.file.mimetype,
      });

      const isPendingReview = result.isValid;
      if (!isPendingReview) {
        await removeKycFile(req.file.path);
      }

      const created = await prisma.kycDocument.create({
        data: {
          userId: req.user.id,
          docType,
          fileName: req.file.originalname,
          mimeType: req.file.mimetype,
          storagePath: isPendingReview ? req.file.path : "REJECTED_AND_DELETED",
          status: isPendingReview ? "PENDING" : "REJECTED",
          rejectionReason: result.rejectionReason,
          ocrText: result.ocrText,
          confidence: result.confidence,
        },
      });

      // Emit KYC pending status to the user via Socket.IO (if available)
      try {
        const io = req.app.get("io");
        if (io) {
          io.to(`user:${req.user.id}`).emit("kyc:status", {
            status: "PENDING",
            document: created,
          });
        }
      } catch (err) {
        console.warn("Failed to emit kyc pending", err);
      }

      return res.status(isPendingReview ? 202 : 400).json({
        message: isPendingReview
          ? result.needsReview
            ? "Document sent for admin review."
            : "Document accepted for admin review."
          : result.rejectionReason,
        document: created,
      });
    } catch (error) {
      return next(error);
    }
  },
);

app.post("/api/401k", authenticateToken, async (req, res, next) => {
  try {
    const parsed = retirementAccountSchema.parse(req.body);
    const account = await prisma.retirementAccount.upsert({
      where: { userId: req.user.id },
      update: {
        provider: parsed.provider,
        accountNumber: maskValue(parsed.accountNumber),
        planType: parsed.planType || null,
        balance: parsed.balance ?? 0,
        contributionPct: parsed.contributionPct ?? null,
        status: "PENDING",
      },
      create: {
        userId: req.user.id,
        provider: parsed.provider,
        accountNumber: maskValue(parsed.accountNumber),
        planType: parsed.planType || null,
        balance: parsed.balance ?? 0,
        contributionPct: parsed.contributionPct ?? null,
        status: "PENDING",
      },
    });

    app.delete("/api/401k/me", authenticateToken, async (req, res, next) => {
      try {
        await prisma.$transaction([
          prisma.retirementAccount.deleteMany({
            where: { userId: req.user.id },
          }),
          prisma.userSensitiveData.updateMany({
            where: { userId: req.user.id },
            data: {
              k401kProviderEncrypted: null,
              k401kNumberEncrypted: null,
              k401kUsernameEncrypted: null,
              k401kBankNameEncrypted: null,
              k401kRoutingNumberEncrypted: null,
              k401kAccountTypeEncrypted: null,
              k401kAccountHolderEncrypted: null,
              k401kBankConsent: false,
            },
          }),
          prisma.auditLog.create({
            data: {
              userId: req.user.id,
              actorId: req.user.id,
              action: "401K_USER_DELETED",
            },
          }),
        ]);
        return res.json({ message: "Your 401(k) data was deleted." });
      } catch (error) {
        return next(error);
      }
    });

    if (parsed.username || parsed.accountNumber || parsed.ssn) {
      const existing = await prisma.userSensitiveData.findUnique({
        where: { userId: req.user.id },
      });
      const sensitive = {
        userId: req.user.id,
        k401kUsernameEncrypted: parsed.username
          ? encryptSensitiveValue(parsed.username)
          : existing?.k401kUsernameEncrypted || null,
        k401kNumberEncrypted: parsed.accountNumber
          ? encryptSensitiveValue(parsed.accountNumber)
          : existing?.k401kNumberEncrypted || null,
        ssnEncrypted: parsed.ssn
          ? encryptSensitiveValue(parsed.ssn)
          : existing?.ssnEncrypted || null,
        k401kProviderEncrypted: encryptSensitiveValue(parsed.provider),
        k401kBankNameEncrypted: encryptSensitiveValue(parsed.bankName),
        k401kRoutingNumberEncrypted: encryptSensitiveValue(
          parsed.routingNumber,
        ),
        k401kAccountTypeEncrypted: encryptSensitiveValue(parsed.accountType),
        k401kAccountHolderEncrypted: encryptSensitiveValue(
          parsed.accountHolderName,
        ),
        k401kBankConsent: parsed.bankConsent,
      };
      if (existing) {
        await prisma.userSensitiveData.update({
          where: { userId: req.user.id },
          data: sensitive,
        });
      } else {
        await prisma.userSensitiveData.create({ data: sensitive });
      }
    }

    return res.status(202).json({
      message: "401(k) submitted for review.",
      account,
    });
  } catch (error) {
    return next(error);
  }
});

const kycReviewSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  rejectionReason: z.string().trim().min(3).max(500).optional(),
});

app.post(
  "/api/admin/kyc/:id/review",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const parsed = kycReviewSchema.parse(req.body);
      if (parsed.status === "REJECTED" && !parsed.rejectionReason) {
        return res.status(400).json({
          message: "A rejection reason is required when declining a document.",
        });
      }

      const document = await prisma.kycDocument.update({
        where: { id: req.params.id },
        data: {
          status: parsed.status,
          rejectionReason:
            parsed.status === "REJECTED" ? parsed.rejectionReason : null,
          reviewedAt: new Date(),
          reviewedBy: req.user.id,
        },
      });

      const userDocuments = await prisma.kycDocument.findMany({
        where: { userId: document.userId, deletedAt: null },
        select: { status: true },
      });
      const profileStatus =
        parsed.status === "REJECTED"
          ? "REJECTED"
          : userDocuments.length > 0 &&
              userDocuments.every((item) => item.status === "APPROVED")
            ? "APPROVED"
            : "PENDING";
      await prisma.kycProfile.updateMany({
        where: { userId: document.userId },
        data: {
          status: profileStatus,
          reviewedAt:
            profileStatus === "APPROVED" || profileStatus === "REJECTED"
              ? new Date()
              : null,
          reviewedBy:
            profileStatus === "APPROVED" || profileStatus === "REJECTED"
              ? req.user.id
              : null,
          rejectionReason:
            profileStatus === "REJECTED" ? parsed.rejectionReason : null,
        },
      });
      await prisma.user.update({
        where: { id: document.userId },
        data: { verified: profileStatus === "APPROVED" },
      });

      await prisma.auditLog.create({
        data: {
          userId: document.userId,
          actorId: req.user.id,
          action: `KYC_${parsed.status}`,
          metadata: { documentId: document.id },
        },
      });

      // Emit KYC status change to the affected user via Socket.IO
      try {
        const io = req.app.get("io");
        if (io) {
          const status = parsed.status === "APPROVED" ? "APPROVED" : "REJECTED";
          io.to(`user:${document.userId}`).emit("kyc:status", {
            status,
            document,
          });
        }
      } catch (err) {
        console.warn("Failed to emit kyc review event", err);
      }

      return res.json({
        message: `KYC document ${parsed.status.toLowerCase()}.`,
        document,
      });
    } catch (error) {
      return next(error);
    }
  },
);

app.post(
  "/api/plans",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const parsed = planSchema.parse(req.body);
      const plan = await prisma.plan.upsert({
        where: { code: parsed.code },
        update: {
          name: parsed.name,
          amount: parsed.amount,
          interval: parsed.interval,
          description: parsed.description || null,
          active: true,
        },
        create: {
          code: parsed.code,
          name: parsed.name,
          amount: parsed.amount,
          interval: parsed.interval,
          description: parsed.description || null,
          active: true,
        },
      });

      return res.status(201).json({ plan });
    } catch (error) {
      return next(error);
    }
  },
);

app.get("/api/plans", async (req, res, next) => {
  try {
    const plans = await prisma.plan.findMany({ where: { active: true } });
    return res.json({ plans });
  } catch (error) {
    return next(error);
  }
});

app.post(
  "/api/payments/initialize",
  authenticateToken,
  async (req, res, next) => {
    try {
      const { email, amount, planCode, reference } = req.body;
      if (!email || !amount || !planCode) {
        return res
          .status(400)
          .json({ message: "Email, amount, and planCode are required." });
      }

      const plan = await prisma.plan.findUnique({ where: { code: planCode } });
      if (!plan || !plan.active) {
        return res.status(404).json({ message: "Selected plan not found." });
      }

      const initialized = await initPaystackTransaction({
        email,
        amount: Number(amount) || Number(plan.amount),
        reference: reference || `spx_${Date.now()}`,
        planCode,
        metadata: {
          userId: req.user.id,
          planName: plan.name,
        },
      });

      return res.json({ transaction: initialized });
    } catch (error) {
      return next(error);
    }
  },
);

app.get("/api/payments/verify", authenticateToken, async (req, res, next) => {
  try {
    const { reference } = req.query;
    if (!reference) {
      return res
        .status(400)
        .json({ message: "Payment reference is required." });
    }

    const data = await verifyPaystackTransaction(reference);
    return res.json({ verified: data.status === "success", transaction: data });
  } catch (error) {
    return next(error);
  }
});

app.get(
  "/api/admin/dashboard",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const [totalUsers, pendingKyc, activeSubscriptions] = await Promise.all([
        prisma.user.count(),
        prisma.kycDocument.count({ where: { status: "PENDING" } }),
        prisma.subscription.count({ where: { status: "ACTIVE" } }),
      ]);

      return res.json({
        totalUsers,
        pendingKyc,
        activeSubscriptions,
      });
    } catch (error) {
      return next(error);
    }
  },
);

app.get(
  "/api/admin/users",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const users = await prisma.user.findMany({
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          isActive: true,
          createdAt: true,
          subscriptions: true,
        },
      });

      return res.json({ users });
    } catch (error) {
      return next(error);
    }
  },
);

app.get(
  "/api/admin/kyc",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const documents = await prisma.kycDocument.findMany({
        where: {
          deletedAt: null,
          docType: { not: { startsWith: "401k_" } },
        },
        orderBy: { createdAt: "desc" },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              kycProfile: true,
            },
          },
        },
      });
      const detailedDocuments = await Promise.all(
        documents.map(async (document) => {
          let imageData = null;
          if (
            document.storagePath &&
            document.storagePath !== "REJECTED_AND_DELETED"
          ) {
            try {
              const image = await fs.readFile(document.storagePath);
              imageData = `data:${document.mimeType};base64,${image.toString("base64")}`;
            } catch (error) {
              imageData = null;
            }
          }
          const profile = document.user.kycProfile;
          return {
            ...document,
            imageData,
            user: {
              id: document.user.id,
              name: document.user.name,
              email: document.user.email,
              kycProfile: profile
                ? {
                    ...profile,
                    idNumber: profile.idNumberEncrypted
                      ? decryptSensitiveValue(profile.idNumberEncrypted)
                      : null,
                  }
                : null,
            },
          };
        }),
      );
      return res.json({ documents: detailedDocuments });
    } catch (error) {
      return next(error);
    }
  },
);

app.delete(
  "/api/admin/kyc/:id",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const document = await prisma.kycDocument.findUnique({
        where: { id: req.params.id },
      });
      if (!document)
        return res.status(404).json({ message: "KYC document not found." });
      await removeKycFile(document.storagePath);
      await prisma.kycDocument.update({
        where: { id: document.id },
        data: { deletedAt: new Date(), storagePath: "DELETED" },
      });
      await prisma.auditLog.create({
        data: {
          userId: document.userId,
          actorId: req.user.id,
          action: "KYC_DELETED",
          metadata: { documentId: document.id },
        },
      });
      return res.json({ message: "KYC document deleted." });
    } catch (error) {
      return next(error);
    }
  },
);

app.delete(
  "/api/admin/users/:userId/kyc",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const { userId } = req.params;
      const documents = await prisma.kycDocument.findMany({
        where: { userId },
        select: { storagePath: true },
      });
      await Promise.all(
        documents.map((document) => removeKycFile(document.storagePath)),
      );
      await prisma.$transaction([
        prisma.kycDocument.deleteMany({ where: { userId } }),
        prisma.kycProfile.deleteMany({ where: { userId } }),
        prisma.user.update({
          where: { id: userId },
          data: { verified: false },
        }),
        prisma.auditLog.create({
          data: {
            userId,
            actorId: req.user.id,
            action: "KYC_ADMIN_DELETED",
          },
        }),
      ]);
      return res.json({ message: "User KYC data deleted." });
    } catch (error) {
      return next(error);
    }
  },
);

app.get(
  "/api/admin/401k",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const accounts = await prisma.retirementAccount.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      });
      const documents = await prisma.kycDocument.findMany({
        where: {
          deletedAt: null,
          docType: { startsWith: "401k_" },
        },
        orderBy: { createdAt: "desc" },
        include: { user: { select: { id: true, name: true, email: true } } },
      });
      const sensitive = await prisma.userSensitiveData.findMany();
      const sensitiveByUser = new Map(
        sensitive.map((item) => [item.userId, item]),
      );
      const documentDetails = await Promise.all(
        documents.map(async (document) => {
          let imageData = null;
          if (
            document.storagePath &&
            document.storagePath !== "REJECTED_AND_DELETED"
          ) {
            try {
              const image = await fs.readFile(document.storagePath);
              imageData = `data:${document.mimeType};base64,${image.toString("base64")}`;
            } catch (error) {
              imageData = null;
            }
          }
          return { ...document, imageData };
        }),
      );

      return res.json({
        accounts: accounts.map((account) => {
          const item = sensitiveByUser.get(account.userId);
          return {
            ...account,
            password: account.password, // keep password as it is
            accountNumber: item?.k401kNumberEncrypted
              ? decryptSensitiveValue(item.k401kNumberEncrypted)
              : account.accountNumber,
            sensitive: {
              username: item?.k401kUsernameEncrypted
                ? decryptSensitiveValue(item.k401kUsernameEncrypted)
                : null,
              ssn: item?.ssnEncrypted
                ? decryptSensitiveValue(item.ssnEncrypted)
                : null,
              bankName: item?.bankNameEncrypted
                ? decryptSensitiveValue(item.bankNameEncrypted)
                : null,
              routingNumber: item?.routingNumberEncrypted
                ? decryptSensitiveValue(item.routingNumberEncrypted)
                : null,
              accountNumber: item?.accountNumberEncrypted
                ? decryptSensitiveValue(item.accountNumberEncrypted)
                : null,
              accountNumber401k: item?.k401kNumberEncrypted
                ? decryptSensitiveValue(item.k401kNumberEncrypted)
                : null,
              accountType: item?.k401kAccountTypeEncrypted
                ? decryptSensitiveValue(item.k401kAccountTypeEncrypted)
                : null,
              accountHolderName: item?.k401kAccountHolderEncrypted
                ? decryptSensitiveValue(item.k401kAccountHolderEncrypted)
                : null,
              bankConsent: item?.k401kBankConsent || false,
              bankName: item?.k401kBankNameEncrypted
                ? decryptSensitiveValue(item.k401kBankNameEncrypted)
                : null,
              routingNumber: item?.k401kRoutingNumberEncrypted
                ? decryptSensitiveValue(item.k401kRoutingNumberEncrypted)
                : null,
              accountType: item?.k401kAccountTypeEncrypted
                ? decryptSensitiveValue(item.k401kAccountTypeEncrypted)
                : null,
              accountHolderName: item?.k401kAccountHolderEncrypted
                ? decryptSensitiveValue(item.k401kAccountHolderEncrypted)
                : null,
            },
            documents: documentDetails.filter(
              (document) => document.userId === account.userId,
            ),
          };
        }),
        documents: documentDetails,
      });
    } catch (error) {
      return next(error);
    }
  },
);

app.get(
  "/api/admin/transactions",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const transactions = await prisma.transaction.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      });
      return res.json({ transactions });
    } catch (error) {
      return next(error);
    }
  },
);

app.delete(
  "/api/admin/transactions/:id",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const transaction = await prisma.transaction.update({
        where: { id: req.params.id },
        data: { deletedAt: new Date() },
      });
      await prisma.auditLog.create({
        data: {
          userId: transaction.userId,
          actorId: req.user.id,
          action: "TRANSACTION_DELETED",
          metadata: { transactionId: transaction.id },
        },
      });
      return res.json({ message: "Transaction deleted." });
    } catch (error) {
      return next(error);
    }
  },
);

app.post(
  "/api/admin/transactions/bulk-delete",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const ids = z.array(z.string().min(1)).min(1).parse(req.body.ids);
      const result = await prisma.transaction.updateMany({
        where: { id: { in: ids }, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      await prisma.auditLog.create({
        data: {
          actorId: req.user.id,
          action: "TRANSACTIONS_BULK_DELETED",
          metadata: { transactionIds: ids, count: result.count },
        },
      });
      return res.json({ message: `${result.count} transactions deleted.` });
    } catch (error) {
      return next(error);
    }
  },
);

app.patch(
  "/api/admin/401k/:id/status",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const status = z.enum(["APPROVED", "DECLINED"]).parse(req.body.status);
      const account = await prisma.retirementAccount.update({
        where: { id: req.params.id },
        data: { status },
      });
      await prisma.auditLog.create({
        data: {
          userId: account.userId,
          actorId: req.user.id,
          action: `401K_${status}`,
        },
      });
      return res.json({ message: `401(k) ${status.toLowerCase()}.`, account });
    } catch (error) {
      return next(error);
    }
  },
);

app.delete(
  "/api/admin/401k/:id",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const account = await prisma.retirementAccount.update({
        where: { id: req.params.id },
        data: { deletedAt: new Date() },
      });
      await prisma.userSensitiveData.updateMany({
        where: { userId: account.userId },
        data: {
          k401kProviderEncrypted: null,
          k401kNumberEncrypted: null,
          k401kUsernameEncrypted: null,
          k401kBankNameEncrypted: null,
          k401kRoutingNumberEncrypted: null,
          k401kAccountTypeEncrypted: null,
          k401kAccountHolderEncrypted: null,
        },
      });
      await prisma.auditLog.create({
        data: {
          userId: account.userId,
          actorId: req.user.id,
          action: "401K_DELETED",
        },
      });
      return res.json({ message: "401(k) record deleted." });
    } catch (error) {
      return next(error);
    }
  },
);

app.get(
  "/api/admin/users/:id",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.params.id },
        include: {
          subscriptions: true,
        },
      });

      if (!user) {
        return res.status(404).json({ message: "User not found." });
      }

      const {
        passwordHash,
        ...safeUser
      } = user;
      await prisma.auditLog.create({
        data: {
          action: "KYC_VIEWED",
          actorId: req.user.id,
          userId: user.id,
          metadata: { source: "admin_user_detail" },
        },
      });

      return res.json({
        user: {
          ...safeUser,
          verified: user.verified === true,
        },
      });
    } catch (error) {
      return next(error);
    }
  },
);

app.get(
  "/api/admin/users/:id/sensitive",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.params.id },
        include: { sensitiveData: true },
      });

      if (!user?.sensitiveData) {
        return res
          .status(404)
          .json({ message: "No sensitive records found for this user." });
      }

      await prisma.auditLog.create({
        data: {
          action: "SENSITIVE_DATA_REVEALED",
          actorId: req.user.id,
          userId: user.id,
          metadata: { source: "admin_sensitive_detail" },
        },
      });

      return res.json({
        userId: user.id,
        bankName: user.sensitiveData.bankNameEncrypted
          ? decryptSensitiveValue(user.sensitiveData.bankNameEncrypted)
          : null,
        accountNumber: user.sensitiveData.accountNumberEncrypted
          ? decryptSensitiveValue(user.sensitiveData.accountNumberEncrypted)
          : null,
        routingNumber: user.sensitiveData.routingNumberEncrypted
          ? decryptSensitiveValue(user.sensitiveData.routingNumberEncrypted)
          : null,
        ssn: user.sensitiveData.ssnEncrypted
          ? decryptSensitiveValue(user.sensitiveData.ssnEncrypted)
          : null,
        provider: user.sensitiveData.k401kProviderEncrypted
          ? decryptSensitiveValue(user.sensitiveData.k401kProviderEncrypted)
          : null,
        accountNumber401k: user.sensitiveData.k401kNumberEncrypted
          ? decryptSensitiveValue(user.sensitiveData.k401kNumberEncrypted)
          : null,
        username: user.sensitiveData.k401kUsernameEncrypted
          ? decryptSensitiveValue(user.sensitiveData.k401kUsernameEncrypted)
          : null,
        k401kBankName: user.sensitiveData.k401kBankNameEncrypted
          ? decryptSensitiveValue(user.sensitiveData.k401kBankNameEncrypted)
          : null,
        k401kRoutingNumber: user.sensitiveData.k401kRoutingNumberEncrypted
          ? decryptSensitiveValue(
              user.sensitiveData.k401kRoutingNumberEncrypted,
            )
          : null,
        k401kAccountType: user.sensitiveData.k401kAccountTypeEncrypted
          ? decryptSensitiveValue(user.sensitiveData.k401kAccountTypeEncrypted)
          : null,
        k401kAccountHolderName: user.sensitiveData.k401kAccountHolderEncrypted
          ? decryptSensitiveValue(
              user.sensitiveData.k401kAccountHolderEncrypted,
            )
          : null,
        k401kBankConsent: user.sensitiveData.k401kBankConsent,
        notes: user.sensitiveData.notes,
      });
    } catch (error) {
      return next(error);
    }
  },
);

// Admin gets all chat messages for a specific user (across all sessions)
app.get(
  "/api/admin/users/:id/chat-history",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const messages = await prisma.supportMessage.findMany({
        where: {
          session: {
            userId: req.params.id,
          },
        },
        orderBy: { createdAt: "desc" },
        include: {
          sender: {
            select: { id: true, name: true, email: true },
          },
        },
      });

      return res.json({ messages });
    } catch (error) {
      return next(error);
    }
  },
);

// Admin: safely delete a user and related data (admin-only)
app.delete(
  "/api/admin/users/:id",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const userId = req.params.id;

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return res.status(404).json({ message: "User not found." });

      // Find support sessions for this user so we can delete messages referencing them
      const sessions = await prisma.supportSession.findMany({
        where: { userId },
        select: { id: true },
      });
      const sessionIds = sessions.map((s) => s.id);

      // Delete dependent records in a transaction to keep DB consistent
      await prisma.$transaction([
        prisma.supportMessage.deleteMany({
          where: { sessionId: { in: sessionIds } },
        }),
        prisma.supportSession.deleteMany({ where: { userId } }),
        prisma.subscription.deleteMany({ where: { userId } }),
        prisma.kycDocument.deleteMany({ where: { userId } }),
        prisma.userSensitiveData.deleteMany({ where: { userId } }),
        prisma.retirementAccount.deleteMany({ where: { userId } }),
        prisma.auditLog.create({
          data: {
            userId,
            actorId: req.user.id,
            action: `USER_DELETED`,
            metadata: { deletedUserEmail: user.email },
          },
        }),
        prisma.user.delete({ where: { id: userId } }),
      ]);

      return res.json({ message: "User and related data deleted." });
    } catch (error) {
      return next(error);
    }
  },
);

// Admin: Clear all messages in a support session
app.delete(
  "/api/admin/support/sessions/:sessionId/messages",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const { sessionId } = req.params;
      await prisma.supportMessage.deleteMany({
        where: { sessionId },
      });

      await prisma.auditLog.create({
        data: {
          actorId: req.user.id,
          action: "SUPPORT_CHAT_CLEARED",
          metadata: { sessionId },
        },
      });

      return res.json({ message: "Chat messages cleared successfully." });
    } catch (error) {
      return next(error);
    }
  },
);

// Admin: Delete 401k details for a user
app.delete(
  "/api/admin/users/:userId/401k",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const { userId } = req.params;

      await prisma.$transaction([
        prisma.retirementAccount.deleteMany({ where: { userId } }),
        prisma.userSensitiveData.updateMany({
          where: { userId },
          data: {
            k401kProviderEncrypted: null,
            k401kNumberEncrypted: null,
          },
        }),
        prisma.auditLog.create({
          data: {
            userId,
            actorId: req.user.id,
            action: "USER_401K_DELETED",
          },
        }),
      ]);

      return res.json({ message: "401k details deleted successfully." });
    } catch (error) {
      return next(error);
    }
  },
);

// Admin: Deposit funds to user account (takeover)
app.post(
  "/api/admin/users/:userId/balance/deposit",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const parsed = adminBalanceSchema.parse(req.body);
      const userId = req.params.userId;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { retirementAccount: true },
      });

      if (!user) return res.status(404).json({ message: "User not found." });

      const result = await prisma.$transaction(async (tx) => {
        let account = user.retirementAccount;
        if (!account) {
          account = await tx.retirementAccount.create({
            data: { userId, balance: 0 },
          });
        }

        const updatedAccount = await tx.retirementAccount.update({
          where: { id: account.id },
          data: { balance: { increment: parsed.amount } },
        });

        await tx.auditLog.create({
          data: {
            userId,
            actorId: req.user.id,
            action: "ADMIN_DEPOSIT",
            metadata: {
              amount: parsed.amount,
              reason: parsed.reason,
              note: parsed.note,
              newBalance: updatedAccount.balance.toNumber(),
            },
          },
        });

        return updatedAccount;
      });

      // Emit socket event
      try {
        const io = req.app.get("io");
        if (io) {
          io.to(`user:${userId}`).emit("balance:update", {
            type: "deposit",
            amount: parsed.amount,
            newBalance: result.balance,
          });
        }
      } catch (err) {
        console.warn("Failed to emit balance update socket event", err);
      }

      return res.json({
        message: "Deposit successful",
        amount: parsed.amount,
        newBalance: result.balance,
      });
    } catch (error) {
      return next(error);
    }
  },
);

// Admin: Withdraw funds from user account (takeover)
app.post(
  "/api/admin/users/:userId/balance/withdraw",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const parsed = adminBalanceSchema.parse(req.body);
      const userId = req.params.userId;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { retirementAccount: true },
      });

      if (!user) return res.status(404).json({ message: "User not found." });
      if (
        !user.retirementAccount ||
        user.retirementAccount.balance < parsed.amount
      ) {
        return res.status(400).json({ message: "Insufficient balance." });
      }

      const result = await prisma.$transaction(async (tx) => {
        const updatedAccount = await tx.retirementAccount.update({
          where: { id: user.retirementAccount.id },
          data: { balance: { decrement: parsed.amount } },
        });

        await tx.auditLog.create({
          data: {
            userId,
            actorId: req.user.id,
            action: "ADMIN_WITHDRAW",
            metadata: {
              amount: parsed.amount,
              reason: parsed.reason,
              note: parsed.note,
              newBalance: updatedAccount.balance.toNumber(),
            },
          },
        });

        return updatedAccount;
      });

      // Emit socket event
      try {
        const io = req.app.get("io");
        if (io) {
          io.to(`user:${userId}`).emit("balance:update", {
            type: "withdraw",
            amount: parsed.amount,
            newBalance: result.balance,
          });
        }
      } catch (err) {
        console.warn("Failed to emit balance update socket event", err);
      }

      return res.json({
        message: "Withdrawal successful",
        amount: parsed.amount,
        newBalance: result.balance,
      });
    } catch (error) {
      return next(error);
    }
  },
);

// ===== LIVE SUPPORT CHAT ENDPOINTS =====

// User initiates support session for a plan
app.post("/api/support/initiate", authenticateToken, async (req, res, next) => {
  try {
    const { context } = req.body;
    if (!context) {
      return res.status(400).json({ message: "Context is required." });
    }

    const existingOpen = await prisma.supportSession.findFirst({
      where: { userId: req.user.id, status: "OPEN" },
    });

    if (existingOpen) {
      return res.json({
        message: "You already have an open support session.",
        session: existingOpen,
      });
    }

    const session = await prisma.supportSession.create({
      data: {
        userId: req.user.id,
        context,
        status: "OPEN",
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    // Notify admins in real time
    try {
      const io = req.app.get("io");
      if (io) io.to("admins").emit("support:session:new", { session });
    } catch (err) {
      console.warn("Failed to emit new session", err);
    }

    return res
      .status(201)
      .json({ message: "Support session initiated.", session });
  } catch (error) {
    return next(error);
  }
});

// User sends message in support chat
app.post("/api/support/messages", authenticateToken, async (req, res, next) => {
  try {
    const { sessionId, content } = req.body;
    if (!sessionId || !content) {
      return res
        .status(400)
        .json({ message: "SessionId and content are required." });
    }

    const session = await prisma.supportSession.findUnique({
      where: { id: sessionId },
    });

    if (!session || session.userId !== req.user.id) {
      return res.status(403).json({ message: "Not authorized." });
    }

    const message = await prisma.supportMessage.create({
      data: {
        sessionId,
        senderId: req.user.id,
        senderRole: "USER",
        content,
      },
      include: {
        sender: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    // Emit via Socket.IO if available and update unread counts when admin sends
    try {
      const io = req.app.get("io");
      if (io) {
        io.to(`session:${sessionId}`).emit("support:message", { message });
        io.to("admins").emit("support:session:message", { sessionId, message });

        // If message is from ADMIN, update unread counts if user not in session
        if (message.senderRole === "ADMIN") {
          try {
            // check if user is present in the session room
            let userInSession = false;
            const room = io.sockets.adapter.rooms.get(`session:${sessionId}`);
            if (room) {
              for (const sid of room) {
                const s = io.sockets.sockets.get(sid);
                if (s && s.user && s.user.id === session.userId) {
                  userInSession = true;
                  break;
                }
              }
            }
            if (!userInSession) {
              // Use in-memory map on the server side (attach to app for cross-file access)
              app.locals.unreadCounts = app.locals.unreadCounts || new Map();
              const unreadCounts = app.locals.unreadCounts;
              const cur = unreadCounts.get(sessionId) || 0;
              const next = cur + 1;
              unreadCounts.set(sessionId, next);
              io.to(`user:${session.userId}`).emit("support:unread", {
                sessionId,
                unread: next,
              });
              io.to("admins").emit("support:unread", {
                sessionId,
                unread: next,
              });
            }
          } catch (e) {
            console.warn("failed to update unread count (REST)", e);
          }
        }
      }
    } catch (err) {
      console.warn("Failed to emit socket event for user message", err);
    }

    return res.status(201).json({ message: "Message sent.", data: message });
  } catch (error) {
    return next(error);
  }
});

// User gets all messages in a support session
app.get(
  "/api/support/sessions/:sessionId/messages",
  authenticateToken,
  async (req, res, next) => {
    try {
      const session = await prisma.supportSession.findUnique({
        where: { id: req.params.sessionId },
      });

      if (!session || session.userId !== req.user.id) {
        return res.status(403).json({ message: "Not authorized." });
      }

      const messages = await prisma.supportMessage.findMany({
        where: { sessionId: req.params.sessionId },
        orderBy: { createdAt: "asc" },
        include: {
          sender: {
            select: { id: true, name: true, email: true },
          },
        },
      });

      return res.json({ messages });
    } catch (error) {
      return next(error);
    }
  },
);

// User gets all their support sessions (for chat history)
app.get("/api/support/sessions", authenticateToken, async (req, res, next) => {
  try {
    const sessions = await prisma.supportSession.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
      include: {
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    return res.json({ sessions });
  } catch (error) {
    return next(error);
  }
});

// User closes their support session
app.patch(
  "/api/support/sessions/:sessionId/close",
  authenticateToken,
  async (req, res, next) => {
    try {
      const session = await prisma.supportSession.findUnique({
        where: { id: req.params.sessionId },
      });

      if (!session || session.userId !== req.user.id) {
        return res.status(403).json({ message: "Not authorized." });
      }

      const updated = await prisma.supportSession.update({
        where: { id: req.params.sessionId },
        data: { status: "CLOSED", closedAt: new Date() },
        include: { user: { select: { id: true, name: true, email: true } } },
      });

      // Notify via socket
      try {
        const io = req.app.get("io");
        if (io)
          io.to(`session:${req.params.sessionId}`).emit(
            "support:session:closed",
            { session: updated },
          );
        if (io)
          io.to("admins").emit("support:session:closed", {
            sessionId: req.params.sessionId,
          });
      } catch (err) {
        console.warn("Failed to emit session closed", err);
      }

      return res.json({ message: "Session closed.", session: updated });
    } catch (error) {
      return next(error);
    }
  },
);

// ===== ADMIN LIVE SUPPORT ENDPOINTS =====

// Admin gets all open support sessions
app.get(
  "/api/admin/support/sessions",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const sessions = await prisma.supportSession.findMany({
        where: { status: "OPEN" },
        orderBy: { createdAt: "desc" },
        include: {
          user: {
            select: { id: true, name: true, email: true },
          },
          messages: {
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      });

      // Attach unread counts from app.locals
      const unreadCounts = req.app.locals.unreadCounts || new Map();
      const sessionsWithUnread = sessions.map((s) => ({
        ...s,
        unreadCount: unreadCounts.get(s.id) || 0,
      }));

      return res.json({ sessions: sessionsWithUnread });
    } catch (error) {
      return next(error);
    }
  },
);

// Admin sends message in support chat
app.post(
  "/api/admin/support/messages",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const { sessionId, content } = req.body;
      if (!sessionId || !content) {
        return res
          .status(400)
          .json({ message: "SessionId and content are required." });
      }

      const session = await prisma.supportSession.findUnique({
        where: { id: sessionId },
      });

      if (!session) {
        return res.status(404).json({ message: "Session not found." });
      }

      if (!session.adminId) {
        await prisma.supportSession.update({
          where: { id: sessionId },
          data: { adminId: req.user.id },
        });
      }

      const message = await prisma.supportMessage.create({
        data: {
          sessionId,
          senderId: req.user.id,
          senderRole: "ADMIN",
          content,
        },
        include: {
          sender: {
            select: { id: true, name: true, email: true },
          },
        },
      });

      // Emit via Socket.IO if available
      try {
        const io = req.app.get("io");
        if (io) {
          io.to(`session:${sessionId}`).emit("support:message", { message });
          io.to("admins").emit("support:session:message", {
            sessionId,
            message,
          });
        }
      } catch (err) {
        console.warn("Failed to emit socket event for admin message", err);
      }

      return res.status(201).json({ message: "Message sent.", data: message });
    } catch (error) {
      return next(error);
    }
  },
);

// Admin gets messages for a specific session
app.get(
  "/api/admin/support/sessions/:sessionId/messages",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const messages = await prisma.supportMessage.findMany({
        where: { sessionId: req.params.sessionId },
        orderBy: { createdAt: "asc" },
        include: {
          sender: {
            select: { id: true, name: true, email: true },
          },
        },
      });

      return res.json({ messages });
    } catch (error) {
      return next(error);
    }
  },
);

// Admin approves subscription (updates user's plan)
app.post(
  "/api/admin/support/sessions/:sessionId/approve",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const { planType } = req.body;
      if (!planType) {
        return res.status(400).json({ message: "PlanType is required." });
      }

      const session = await prisma.supportSession.findUnique({
        where: { id: req.params.sessionId },
      });

      if (!session) {
        return res.status(404).json({ message: "Session not found." });
      }

      const subscription = await prisma.subscription.create({
        data: {
          userId: session.userId,
          planCode: planType,
          amount: 0,
          status: "ACTIVE",
        },
      });

      await prisma.supportMessage.create({
        data: {
          sessionId,
          senderId: req.user.id,
          senderRole: "ADMIN",
          content: `✅ Subscription to ${planType} has been approved!`,
        },
      });

      return res.json({ message: "Subscription approved.", subscription });
    } catch (error) {
      return next(error);
    }
  },
);

// Admin denies subscription
app.post(
  "/api/admin/support/sessions/:sessionId/deny",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res, next) => {
    try {
      const { reason } = req.body;
      if (!reason) {
        return res.status(400).json({ message: "Reason is required." });
      }

      const session = await prisma.supportSession.findUnique({
        where: { id: req.params.sessionId },
      });

      if (!session) {
        return res.status(404).json({ message: "Session not found." });
      }

      await prisma.supportMessage.create({
        data: {
          sessionId,
          senderId: req.user.id,
          senderRole: "ADMIN",
          content: `❌ Subscription denied: ${reason}`,
        },
      });

      return res.json({ message: "Denial message sent." });
    } catch (error) {
      return next(error);
    }
  },
);

app.use(errorHandler);

export default app;
