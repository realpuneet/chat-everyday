import * as S from '../validators/socketSchemas.js';

/** Random 1:1 chat events. */
export function registerRandomHandlers({ on, svc }, socket) {
  const user = () => socket.data.user;

  on('match:start', S.matchStart, async (data) => {
    const res = await svc.chat.start(user(), data);
    return { status: res.status };
  });
  on('match:next', S.matchStart, async (data) => {
    const res = await svc.chat.next(user(), data);
    return { status: res.status };
  });
  on('match:leave', null, async () => {
    const res = await svc.chat.leave(user().id);
    return { left: res.kind };
  });
  on('chat:send', S.chatSend, async (data) => {
    if (data.kind === 'image') {
      await svc.images.assertSendable(user(), data.imageId, { chatId: data.chatId });
    }
    return svc.chat.send(user(), data, socket.id);
  });
  on('chat:typing', S.chatTyping, async (data) => {
    await svc.chat.typing(user().id, data);
  });
  on('chat:resume', S.chatResume, async (data) => svc.chat.resume(user(), data));
  on('block:add', S.blockAdd, async ({ chatId, roomId, memberId }) => {
    if (chatId) return svc.chat.blockPartner(user().id, chatId);
    return svc.chat.blockRoomMember(user().id, roomId, memberId, svc.rooms);
  });
  on('report:create', S.reportCreate, async (data) => svc.reports.create(user(), data));
}
