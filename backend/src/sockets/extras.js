import * as S from '../validators/socketSchemas.js';

/** Save-chat consent flow and WebRTC (video) signalling. Image events are handled in random.js / rooms.js. */
export function registerExtraHandlers({ on, svc }, socket) {
  const uid = () => socket.data.user.id;

  on('save:request', S.saveRequest, async ({ chatId }) => svc.saved.request(uid(), chatId));
  on('save:respond', S.saveRespond, async ({ chatId, accept }) => svc.saved.respond(uid(), chatId, accept));
  on('save:stop', S.saveStop, async ({ chatId }) => svc.saved.stop(uid(), chatId));

  on('rtc:request', S.rtcRequest, async ({ chatId }) => svc.rtc.request(uid(), chatId));
  on('rtc:respond', S.rtcRespond, async ({ chatId, accept }) => svc.rtc.respond(uid(), chatId, accept));
  on('rtc:signal', S.rtcSignal, async (data) => {
    await svc.rtc.signal(uid(), data);
  });
  on('rtc:end', S.rtcEnd, async ({ chatId }) => {
    await svc.rtc.end(uid(), chatId);
  });
}
