const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

// Creates and configures the Socket.IO server on top of the existing HTTP
// server. Called once from server.js.
//
// Scaling note: presence/online-user state currently lives in-memory
// (see socket/chatSocket.js). That's fine for a single Node process. The
// moment ADMS runs more than one instance behind a load balancer, swap the
// in-memory Map for Redis and add @socket.io/redis-adapter here so events
// broadcast across instances:
//
//   const { createAdapter } = require('@socket.io/redis-adapter');
//   const { createClient } = require('redis');
//   const pubClient = createClient({ url: process.env.REDIS_URL });
//   const subClient = pubClient.duplicate();
//   await Promise.all([pubClient.connect(), subClient.connect()]);
//   io.adapter(createAdapter(pubClient, subClient));
const createSocketServer = (httpServer) => {
  const io = new Server(httpServer, {
    cors: {
      origin: process.env.CORS_ORIGIN || '*',
      methods: ['GET', 'POST'],
    },
    maxHttpBufferSize: 5 * 1024 * 1024, // generous enough for small inline payloads; large files go via REST upload
  });

  // Same JWT used by the REST API (see authMiddleware.js) — the client sends
  // it once at connection time instead of on every event.
  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      (socket.handshake.headers?.authorization || '').replace('Bearer ', '');

    if (!token) {
      return next(new Error('Authentication token is required.'));
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
      if (err) {
        return next(new Error('Invalid or expired token.'));
      }
      socket.user = decoded; // { id, username }
      next();
    });
  });

  return io;
};

module.exports = createSocketServer;