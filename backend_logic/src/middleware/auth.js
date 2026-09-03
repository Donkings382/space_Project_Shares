import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { prisma } from "../config/db.js";

export function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: "Authentication required." });
  }

  try {
    const payload = jwt.verify(token, env.jwtSecret);
    req.user = payload;
    return next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid or expired session." });
  }
}

export function requireRole(roles) {
  return async function roleGuard(req, res, next) {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ message: "Authentication required." });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    if (!user || !roles.includes(user.role)) {
      return res.status(403).json({ message: "Insufficient permissions." });
    }

    req.user.role = user.role;
    return next();
  };
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "ADMIN") {
    return res.status(403).json({ message: "Admin privileges required." });
  }
  return next();
}
