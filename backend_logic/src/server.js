import app from "./app.js";
import { connectDatabase, prisma } from "./config/db.js";
import { env } from "./config/env.js";
import http from "node:http";
import jwt from "jsonwebtoken";
import { Server as SocketIOServer } from "socket.io";

async function bootstrap() {
  await connectDatabase();

  const server = http.createServer(app);

  const io = new SocketIOServer(server, {
    cors: {
      origin: (origin, callback) => {
        const allowed =
          !origin || env.allowedOrigins.includes(origin) || origin === "null";
        callback(null, allowed);
      },
      credentials: true,
    },
    path: "/socket.io",
  });

  // Make io available to express routes
  app.set("io", io);

  // In-memory unread counts per session (survives until server restarts).
  // For durable persistence across restarts or multi-instance, add a DB column.
  const unreadCounts = new Map();
  // expose to express app (so REST routes can access it)
  app.locals.unreadCounts = unreadCounts;

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) return next(new Error("Authentication required"));
      const payload = jwt.verify(token, env.jwtSecret);
      const user = await prisma.user.findUnique({
        where: { id: payload.id },
        select: { id: true, email: true, role: true, isActive: true },
      });
      if (!user || !user.isActive) return next(new Error("Invalid session"));
      socket.user = user;
    } catch (err) {
      return next(new Error("Invalid session"));
    }
    return next();
  });

  io.on("connection", (socket) => {
    // Join rooms for user and admins
    if (socket.user && socket.user.id) {
      socket.join(`user:${socket.user.id}`);
      if (socket.user.role === "ADMIN") socket.join("admins");
    }

    socket.on("joinSession", async (sessionId) => {
      try {
        // verify session exists
        const session = await prisma.supportSession.findUnique({
          where: { id: sessionId },
        });
        if (!session) return;
        if (socket.user.role !== "ADMIN" && session.userId !== socket.user.id) {
          return;
        }
        socket.join(`session:${sessionId}`);

        // Clear unread count for this session when a user joins
        try {
          const cur = unreadCounts.get(sessionId) || 0;
          if (cur > 0) {
            unreadCounts.delete(sessionId);
            // notify the user and admins that unread has been cleared
            io.to(`user:${session.userId}`).emit("support:unread", {
              sessionId,
              unread: 0,
            });
            io.to("admins").emit("support:unread", { sessionId, unread: 0 });
          }
        } catch (e) {
          console.warn("failed clearing unread on join", e);
        }
      } catch (err) {
        console.warn("joinSession error", err);
      }
    });

    socket.on("leaveSession", (sessionId) => {
      socket.leave(`session:${sessionId}`);
    });

    // Allow sending messages via socket for lower latency
    socket.on("support:send", async (payload, ack) => {
      try {
        const { sessionId, content } = payload || {};
        if (!sessionId || !content)
          return ack && ack({ error: "sessionId and content required" });

        const session = await prisma.supportSession.findUnique({
          where: { id: sessionId },
        });
        if (!session) return ack && ack({ error: "session not found" });

        const senderId = socket.user.id;
        const senderRole = socket.user.role === "ADMIN" ? "ADMIN" : "USER";

        // Basic ownership check for users
        if (senderRole === "USER" && session.userId !== senderId) {
          return ack && ack({ error: "Not authorized" });
        }
        if (session.status !== "OPEN") {
          return ack && ack({ error: "Session is closed" });
        }
        if (typeof content !== "string" || content.trim().length > 2000) {
          return ack && ack({ error: "Message must be 1-2000 characters" });
        }

        // Attach adminId if first admin
        if (
          senderRole === "ADMIN" &&
          !session.adminId &&
          socket.user &&
          socket.user.id
        ) {
          await prisma.supportSession.update({
            where: { id: sessionId },
            data: { adminId: socket.user.id },
          });
        }

        const message = await prisma.supportMessage.create({
          data: {
            sessionId,
            senderId,
            senderRole,
            content: content.trim(),
          },
          include: {
            sender: { select: { id: true, name: true, email: true } },
          },
        });

        const ioMsg = { message };
        io.to(`session:${sessionId}`).emit("support:message", ioMsg);
        io.to("admins").emit("support:session:message", { sessionId, message });

        // If admin sent the message and the user is not currently in the session room, increment unread
        if (senderRole === "ADMIN") {
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
              const cur = unreadCounts.get(sessionId) || 0;
              const next = cur + 1;
              unreadCounts.set(sessionId, next);
              // notify user and admins
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
            console.warn("failed to update unread count", e);
          }
        }

        ack && ack({ ok: true, data: message });
      } catch (err) {
        console.error("support:send error", err);
        ack && ack({ error: "internal" });
      }
    });

    socket.on("disconnect", () => {
      // nothing yet
    });
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `Port ${env.port} is already in use. Stop the existing backend before starting another instance.`,
      );
      process.exit(1);
    }
    throw error;
  });

  server.listen(env.port, () => {
    console.log(`SpaceX backend listening on port ${env.port}`);
  });
}

bootstrap().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
