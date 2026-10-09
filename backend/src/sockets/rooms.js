import * as S from '../validators/socketSchemas.js';

/** Group-room events. Every handler is schema-validated, rate-limited and acked by ctx.on(). */
export function registerRoomHandlers({ on, svc }, socket) {
  const user = () => socket.data.user;

  on('room:join', S.roomJoin, async (data) => ({ ...(await svc.rooms.join(user(), data)) }));
  on('room:leave', S.roomLeave, async ({ roomId }) => {
    await svc.rooms.leave(user().id, roomId);
  });
  on('room:resume', S.roomResume, async (data) => svc.rooms.resume(user(), data));
  on('room:send', S.roomSend, async (data) => {
    if (data.kind !== 'image') return svc.rooms.send(user(), data);
    await svc.images.assertSendable(user(), data.imageId, { roomId: data.roomId });
    try {
      return await svc.rooms.send(user(), data);
    } catch (e) {
      await svc.images.releaseSend(data.imageId);
      throw e;
    }
  });
  on('room:typing', S.roomTyping, async (data) => {
    await svc.rooms.typing(user(), data);
  });
  on('room:mod', S.roomMod, async (data) => svc.rooms.moderate(user(), data));
}
