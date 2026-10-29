const chatModel = require('../models/chatModel');
const callModel = require('../models/callModel');

// In-memory presence registry: userId -> Set of socket ids (a user can have
// multiple tabs/devices open at once, all counted as "online").
// See the scaling note in config/socket.js for swapping this for Redis.
const onlineUsers = new Map();

const userRoom = (userId) => `user:${userId}`;
const callRoom = (callId) => `call:${callId}`;

const isUserOnline = (userId) => onlineUsers.has(String(userId));

// Serializes a `calls` row into the shape the client's call-history list
// and in-call UI expect.
const serializeCall = (call) => ({
  callId: call.id,
  conversationId: call.conversation_id,
  callerId: call.caller_id,
  callType: call.call_type,
  isGroup: call.is_group,
  status: call.status,
  startedAt: call.started_at,
  answeredAt: call.answered_at,
  endedAt: call.ended_at,
  durationSeconds: call.duration_seconds,
});

const registerChatSocket = (io) => {
  // Lets REST controllers (group participant add/remove/admin changes)
  // push a live update to everyone currently in that conversation, the
  // same way socket-originated changes do.
  io.emitToConversation = async (conversationId, event, payload) => {
    try {
      const participantIds = await chatModel.findParticipantIds(conversationId);
      participantIds.forEach((id) => io.to(userRoom(id)).emit(event, payload));
    } catch (err) {
      console.error(`emitToConversation failed for ${event}:`, err);
    }
  };

  io.on('connection', async (socket) => {
    const userId = String(socket.user.id);

    // --- presence: mark online, join a personal room for direct addressing ---
    // Everything below (including every other listener this handler
    // registers) runs synchronously against THIS connection before the
    // event loop yields, so there is no window where the socket is
    // connected but not yet listening for calls/messages — the previous
    // "first call after login is missed" bug lived in the *frontend*
    // hook re-subscribing to a socket instance that didn't exist yet, not
    // here; see useWebRTCCall's useSocket() usage for the fix.
    if (!onlineUsers.has(userId)) {
      onlineUsers.set(userId, new Set());
    }
    onlineUsers.get(userId).add(socket.id);
    socket.join(userRoom(userId));

    const wasAlreadyOnline = onlineUsers.get(userId).size > 1;
    if (!wasAlreadyOnline) {
      socket.broadcast.emit('presence:update', { userId: socket.user.id, status: 'online' });
    }

    // Tell this client who else is currently online, so it can render
    // presence dots immediately instead of waiting for individual updates.
    socket.emit('presence:online-list', { userIds: Array.from(onlineUsers.keys()).map(Number) });

    // Anything sent to this user while they were offline flips 'sent' -> 'delivered'
    // now that they're back; notify each original sender so their ticks update.
    try {
      const nowDelivered = await chatModel.markAllPendingDeliveredForUser(socket.user.id);
      nowDelivered.forEach((row) => {
        io.to(userRoom(row.sender_id)).emit('message:status', {
          messageId: row.id,
          conversationId: row.conversation_id,
          status: 'delivered',
        });
      });
    } catch (err) {
      console.error('Failed to flush pending deliveries on connect:', err);
    }

    // --- typing indicators (ephemeral — never persisted) ---
    socket.on('typing:start', ({ conversationId, toUserId }) => {
      if (!toUserId) return;
      socket.to(userRoom(toUserId)).emit('typing:update', {
        conversationId,
        userId: socket.user.id,
        isTyping: true,
      });
    });

    socket.on('typing:stop', ({ conversationId, toUserId }) => {
      if (!toUserId) return;
      socket.to(userRoom(toUserId)).emit('typing:update', {
        conversationId,
        userId: socket.user.id,
        isTyping: false,
      });
    });

    // --- messaging ---
    // Text is sent inline. For media, the client first POSTs the file to
    // /api/chat/conversations/:id/media (see chatController.uploadChatMedia)
    // and then sends this event with the returned storageKey/thumbnailKey —
    // large binary payloads never travel over the socket itself.
    // Works identically for group conversations: findParticipantIds simply
    // returns every member instead of just two people.
    socket.on('message:send', async (data, ack) => {
      try {
        const {
          conversationId,
          tempId,
          content = null,
          messageType = 'text',
          storageKey = null,
          thumbnailKey = null,
          originalFilename = null,
          mimeType = null,
          sizeBytes = null,
        } = data || {};

        const allowed = await chatModel.isParticipant(conversationId, socket.user.id);
        if (!allowed) {
          if (typeof ack === 'function') ack({ error: 'Not a participant of this conversation.' });
          return;
        }
        if (await chatModel.isDirectWithDeletedUser(conversationId)) {
          if (typeof ack === 'function') ack({ error: 'This person\'s account was deleted. Messages can no longer be sent here.' });
          return;
        }

        const message = await chatModel.createMessage({
          conversation_id: conversationId,
          sender_id: socket.user.id,
          content,
          message_type: messageType,
          storage_key: storageKey,
          thumbnail_key: thumbnailKey,
          original_filename: originalFilename,
          mime_type: mimeType,
          size_bytes: sizeBytes,
        });

        const participantIds = await chatModel.findParticipantIds(conversationId);
        const recipientIds = participantIds.filter((id) => String(id) !== userId);
        const payload = { ...message, tempId };

        // Broadcast to every participant's personal room (covers multi-device
        // sync for the sender too) rather than a conversation room, since a
        // client only needs to be logged in — not "inside" the thread — to
        // receive it.
        participantIds.forEach((id) => io.to(userRoom(id)).emit('message:new', payload));

        // If the recipient is online right now, flip to 'delivered' immediately.
        const onlineRecipients = recipientIds.filter((id) => isUserOnline(id));
        if (onlineRecipients.length > 0) {
          const delivered = await chatModel.markMessageDelivered(message.id);
          if (delivered) {
            participantIds.forEach((id) =>
              io.to(userRoom(id)).emit('message:status', {
                messageId: message.id,
                conversationId,
                status: 'delivered',
              })
            );
          }
        }

        if (typeof ack === 'function') ack({ message: payload });
      } catch (err) {
        console.error('message:send failed:', err);
        if (typeof ack === 'function') ack({ error: 'Failed to send message.' });
      }
    });

    // Recipient's client calls this the moment it opens/focuses the
    // conversation thread — flips 'sent'/'delivered' -> 'read' (blue ticks)
    // for every inbound message in that thread.
    socket.on('conversation:read', async ({ conversationId }) => {
      try {
        const allowed = await chatModel.isParticipant(conversationId, socket.user.id);
        if (!allowed) return;

        const readIds = await chatModel.markConversationRead(conversationId, socket.user.id);
        if (readIds.length === 0) return;

        const participantIds = await chatModel.findParticipantIds(conversationId);
        participantIds.forEach((id) =>
          io.to(userRoom(id)).emit('message:status:bulk', {
            conversationId,
            messageIds: readIds,
            status: 'read',
          })
        );
      } catch (err) {
        console.error('conversation:read failed:', err);
      }
    });

    // --- edit / delete (mirrors WhatsApp's "edit"/"delete for everyone") ---
    socket.on('message:edit', async ({ messageId, content }) => {
      try {
        const trimmed = (content || '').trim();
        if (!trimmed) return;
        const updated = await chatModel.editMessage(messageId, socket.user.id, trimmed);
        if (!updated) return; // not the sender, already deleted, or not a text message

        const participantIds = await chatModel.findParticipantIds(updated.conversation_id);
        participantIds.forEach((id) => io.to(userRoom(id)).emit('message:updated', updated));
      } catch (err) {
        console.error('message:edit failed:', err);
      }
    });

    socket.on('message:delete', async ({ messageId }) => {
      try {
        const deleted = await chatModel.deleteMessage(messageId, socket.user.id);
        if (!deleted) return; // not the sender or already deleted

        const participantIds = await chatModel.findParticipantIds(deleted.conversation_id);
        participantIds.forEach((id) =>
          io.to(userRoom(id)).emit('message:deleted', {
            messageId: deleted.id,
            conversationId: deleted.conversation_id,
          })
        );
      } catch (err) {
        console.error('message:delete failed:', err);
      }
    });

    // ==================== 1:1 CALLS ====================
    // Server relays SDP/ICE only; media itself is peer-to-peer. Every call
    // is also persisted (calls/call_participants) so it shows up correctly
    // in each side's call history with the right status and duration.

    socket.on('call:offer', async ({ toUserId, sdp, callType, conversationId }, ack) => {
      // Signaling (ringing the callee) and call-history persistence are two
      // separate concerns. Previously the DB write was awaited BEFORE the
      // offer was relayed, both inside one try/catch — so any DB error
      // (a schema drift issue, a transient connection hiccup, anything)
      // jumped straight to the catch block and the offer was silently
      // never sent. That was the actual cause of "the callee never
      // receives the call": not a signaling bug, a DB-write-blocks-relay
      // bug. Persistence is now best-effort and can never prevent the
      // relay below from happening.
      if (!isUserOnline(toUserId)) {
        socket.emit('call:unavailable', { toUserId });
        if (typeof ack === 'function') ack({ error: 'unavailable' });
        // Log the missed call in the background — failure here must not
        // affect the response already sent to the caller above.
        (async () => {
          try {
            const call = await callModel.createCall({
              conversationId,
              callerId: socket.user.id,
              calleeIds: [toUserId],
              callType,
              isGroup: false,
            });
            await callModel.finalizeCall(call.id); // never answered -> 'missed'
          } catch (err) {
            console.error('Failed to persist missed-call record (call still correctly reported unavailable):', err);
          }
        })();
        return;
      }

      let call = null;
      try {
        call = await callModel.createCall({
          conversationId,
          callerId: socket.user.id,
          calleeIds: [toUserId],
          callType,
          isGroup: false,
        });
      } catch (err) {
        // Persistence failed — still ring the callee. A call that connects
        // but doesn't show up in history is far better than a call that
        // silently never rings at all.
        console.error('call:offer persistence failed (relaying the offer anyway):', err);
      }

      io.to(userRoom(toUserId)).emit('call:offer', {
        fromUserId: socket.user.id,
        sdp,
        callType, // 'audio' | 'video'
        conversationId,
        callId: call?.id ?? null,
      });
      if (typeof ack === 'function') ack({ callId: call?.id ?? null });
    });

    socket.on('call:answer', async ({ toUserId, sdp, callId }) => {
      io.to(userRoom(toUserId)).emit('call:answer', { fromUserId: socket.user.id, sdp });
      if (callId) {
        try {
          const call = await callModel.markParticipantJoined(callId, socket.user.id);
          const participantIds = await chatModel.findParticipantIds(call.conversation_id);
          participantIds.forEach((id) => io.to(userRoom(id)).emit('call:state', serializeCall(call)));
        } catch (err) {
          console.error('call:answer persistence failed:', err);
        }
      }
    });

    // Mid-call renegotiation — used when video (camera or screen share) is
    // added to a call that started audio-only. Same offer/answer dance as
    // call:offer/call:answer above, just on an already-connected peer
    // connection instead of establishing a brand new one, so it doesn't go
    // through the isUserOnline "unavailable" check (the call is already live).
    socket.on('call:renegotiate-offer', ({ toUserId, sdp }) => {
      io.to(userRoom(toUserId)).emit('call:renegotiate-offer', { fromUserId: socket.user.id, sdp });
    });

    socket.on('call:renegotiate-answer', ({ toUserId, sdp }) => {
      io.to(userRoom(toUserId)).emit('call:renegotiate-answer', { fromUserId: socket.user.id, sdp });
    });

    socket.on('call:ice-candidate', ({ toUserId, candidate }) => {
      io.to(userRoom(toUserId)).emit('call:ice-candidate', { fromUserId: socket.user.id, candidate });
    });

    socket.on('call:reject', async ({ toUserId, callId }) => {
      io.to(userRoom(toUserId)).emit('call:rejected', { fromUserId: socket.user.id });
      if (callId) {
        try {
          await callModel.markParticipantRejected(callId, socket.user.id);
          const call = await callModel.finalizeCall(callId, { reason: 'rejected' });
          if (call) {
            const participantIds = await chatModel.findParticipantIds(call.conversation_id);
            participantIds.forEach((id) => io.to(userRoom(id)).emit('call:state', serializeCall(call)));
          }
        } catch (err) {
          console.error('call:reject persistence failed:', err);
        }
      }
    });

    socket.on('call:end', async ({ toUserId, callId }) => {
      io.to(userRoom(toUserId)).emit('call:ended', { fromUserId: socket.user.id });
      if (callId) {
        try {
          const call = await callModel.finalizeCall(callId);
          if (call) {
            const participantIds = await chatModel.findParticipantIds(call.conversation_id);
            participantIds.forEach((id) => io.to(userRoom(id)).emit('call:state', serializeCall(call)));
          }
        } catch (err) {
          console.error('call:end persistence failed:', err);
        }
      }
    });

    // ==================== GROUP CALLS ====================
    // Mesh topology: every participant opens a direct RTCPeerConnection to
    // every other participant. Fine for small/medium groups (a handful of
    // people); a large call would need an SFU, which is out of scope here.
    // The server's job is just: track who's in the call room, relay
    // per-peer SDP/ICE, and persist start/join/leave/end.

    // Starts (or joins, if one is already ringing/ongoing) a group call for
    // a group conversation and rings every other member.
    socket.on('group-call:start', async ({ conversationId, callType }, ack) => {
      try {
        const allowed = await chatModel.isParticipant(conversationId, socket.user.id);
        if (!allowed) {
          if (typeof ack === 'function') ack({ error: 'Not a participant of this conversation.' });
          return;
        }

        let call = await callModel.getActiveCallForConversation(conversationId);
        const participantIds = await chatModel.findParticipantIds(conversationId);

        if (!call) {
          call = await callModel.createCall({
            conversationId,
            callerId: socket.user.id,
            calleeIds: participantIds.filter((id) => String(id) !== userId),
            callType,
            isGroup: true,
          });
          const conversation = await chatModel.findConversationById(conversationId);
          participantIds
            .filter((id) => String(id) !== userId)
            .forEach((id) =>
              io.to(userRoom(id)).emit('group-call:incoming', {
                callId: call.id,
                conversationId,
                callType,
                fromUserId: socket.user.id,
                groupName: conversation?.name,
              })
            );
        }

        socket.join(callRoom(call.id));
        const updatedCall = await callModel.markParticipantJoined(call.id, socket.user.id);
        const activeParticipantIds = (await callModel.listActiveParticipantIds(call.id)).filter(
          (id) => String(id) !== userId
        );

        socket.to(callRoom(call.id)).emit('group-call:participant-joined', {
          callId: call.id,
          userId: socket.user.id,
        });
        participantIds.forEach((id) => io.to(userRoom(id)).emit('call:state', serializeCall(updatedCall)));

        if (typeof ack === 'function') {
          ack({ callId: call.id, callType: updatedCall.call_type, participantIds: activeParticipantIds });
        }
      } catch (err) {
        console.error('group-call:start failed:', err);
        if (typeof ack === 'function') ack({ error: 'Failed to start group call.' });
      }
    });

    // A member joins an already-ringing/ongoing group call (either after
    // accepting the 'group-call:incoming' ring, or dropping into a call
    // that's already going, Teams-style).
    socket.on('group-call:join', async ({ conversationId, callId }, ack) => {
      try {
        const allowed = await chatModel.isParticipant(conversationId, socket.user.id);
        if (!allowed) {
          if (typeof ack === 'function') ack({ error: 'Not a participant of this conversation.' });
          return;
        }

        const activeParticipantIds = (await callModel.listActiveParticipantIds(callId)).filter(
          (id) => String(id) !== userId
        );

        socket.join(callRoom(callId));
        const updatedCall = await callModel.markParticipantJoined(callId, socket.user.id);

        socket.to(callRoom(callId)).emit('group-call:participant-joined', { callId, userId: socket.user.id });

        const participantIds = await chatModel.findParticipantIds(conversationId);
        participantIds.forEach((id) => io.to(userRoom(id)).emit('call:state', serializeCall(updatedCall)));

        if (typeof ack === 'function') {
          ack({ callId, callType: updatedCall.call_type, participantIds: activeParticipantIds });
        }
      } catch (err) {
        console.error('group-call:join failed:', err);
        if (typeof ack === 'function') ack({ error: 'Failed to join group call.' });
      }
    });

    // Declined the ring without ever joining.
    socket.on('group-call:decline', async ({ callId }) => {
      try {
        await callModel.markParticipantRejected(callId, socket.user.id);
        io.to(callRoom(callId)).emit('group-call:participant-declined', { callId, userId: socket.user.id });
      } catch (err) {
        console.error('group-call:decline failed:', err);
      }
    });

    // Per-peer WebRTC signaling within a group call — same shape as the 1:1
    // events, just also carrying callId so the client can route it to the
    // right mesh connection.
    socket.on('group-call:offer', ({ toUserId, sdp, callId }) => {
      io.to(userRoom(toUserId)).emit('group-call:offer', { fromUserId: socket.user.id, sdp, callId });
    });

    socket.on('group-call:answer', ({ toUserId, sdp, callId }) => {
      io.to(userRoom(toUserId)).emit('group-call:answer', { fromUserId: socket.user.id, sdp, callId });
    });

    socket.on('group-call:ice-candidate', ({ toUserId, candidate, callId }) => {
      io.to(userRoom(toUserId)).emit('group-call:ice-candidate', { fromUserId: socket.user.id, candidate, callId });
    });

    // Mute/camera indicators shown on every participant's tile.
    socket.on('group-call:media-state', ({ callId, muted, videoOff }) => {
      socket.to(callRoom(callId)).emit('group-call:media-state', {
        callId,
        userId: socket.user.id,
        muted: Boolean(muted),
        videoOff: Boolean(videoOff),
      });
    });

    const leaveGroupCall = async (callId) => {
      try {
        socket.leave(callRoom(callId));
        await callModel.markParticipantLeft(callId, socket.user.id);
        socket.to(callRoom(callId)).emit('group-call:participant-left', { callId, userId: socket.user.id });

        const remaining = await callModel.countActiveParticipants(callId);
        if (remaining === 0) {
          const call = await callModel.finalizeCall(callId);
          if (call) {
            const participantIds = await chatModel.findParticipantIds(call.conversation_id);
            participantIds.forEach((id) => io.to(userRoom(id)).emit('call:state', serializeCall(call)));
          }
        }
      } catch (err) {
        console.error('group-call leave failed:', err);
      }
    };

    socket.on('group-call:leave', ({ callId }) => leaveGroupCall(callId));

    // --- disconnect ---
    // Use 'disconnecting' (fired BEFORE socket.io removes the socket from
    // its rooms) rather than 'disconnect' so we can still see which
    // call:<id> rooms this connection was in and clean those up too —
    // otherwise a dropped tab/network blip would leave a phantom
    // "still in the call" participant behind forever.
    socket.on('disconnecting', () => {
      const callRoomsJoined = Array.from(socket.rooms || []).filter((room) => room.startsWith('call:'));
      socket.data.callRoomsAtDisconnect = callRoomsJoined;
    });

    socket.on('disconnect', async () => {
      const sockets = onlineUsers.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineUsers.delete(userId);
          try {
            await chatModel.setUserLastSeen(socket.user.id);
            const lastSeen = await chatModel.getUserLastSeen(socket.user.id);
            socket.broadcast.emit('presence:update', {
              userId: socket.user.id,
              status: 'offline',
              lastSeen,
            });
          } catch (err) {
            console.error('Failed to record last_seen on disconnect:', err);
          }
        }
      }

      const callRoomsJoined = socket.data.callRoomsAtDisconnect || [];
      for (const room of callRoomsJoined) {
        const callId = parseInt(room.slice('call:'.length), 10);
        if (!Number.isNaN(callId)) await leaveGroupCall(callId);
      }
    });
  });
};

module.exports = { registerChatSocket, isUserOnline };
