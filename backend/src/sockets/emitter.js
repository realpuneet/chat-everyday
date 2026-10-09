/**
 * Uniform emit API used by services. Works with a live Socket.io server (API process) and with
 * @socket.io/redis-emitter (worker process).
 */
export const rooms = {
  user: (id) => `u:${id}`,
  room: (id) => `r:${id}`,
  admin: 'admins',
};

export function makeEmitter(target, { canDisconnect = true } = {}) {
  return {
    toUser: (userId, event, payload) => target.to(rooms.user(userId)).emit(event, payload),
    toUserExcept: (userId, exceptSocketId, event, payload) =>
      target.to(rooms.user(userId)).except(exceptSocketId).emit(event, payload),
    toRoom: (roomId, event, payload) => target.to(rooms.room(roomId)).emit(event, payload),
    toAdmins: (event, payload) => target.to(rooms.admin).emit(event, payload),
    broadcast: (event, payload) => target.emit(event, payload),
    disconnectUser: canDisconnect ? (userId) => target.in(rooms.user(userId)).disconnectSockets(true) : undefined,
    raw: target,
  };
}

/** Emitter whose target is attached later (the HTTP app is built before Socket.io exists). */
export function createLazyEmitter() {
  let real = null;
  const call =
    (name) =>
    (...args) => {
      if (!real) return undefined;
      return real[name]?.(...args);
    };
  return {
    attach(target, opts) {
      real = makeEmitter(target, opts);
    },
    toUser: call('toUser'),
    toUserExcept: call('toUserExcept'),
    toRoom: call('toRoom'),
    toAdmins: call('toAdmins'),
    broadcast: call('broadcast'),
    disconnectUser: call('disconnectUser'),
    get raw() {
      return real?.raw;
    },
  };
}
