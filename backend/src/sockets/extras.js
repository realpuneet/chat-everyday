import * as S from '../validators/socketSchemas.js';

/** Save-chat consent flow (and, in later phases, image + video signalling) */
export function registerExtraHandlers({ on, svc }, socket) {
  const uid = () => socket.data.user.id;
  on('save:request', S.saveRequest, async ({ chatId }) => svc.saved.request(uid(), chatId));
  on('save:respond', S.saveRespond, async ({ chatId, accept }) => svc.saved.respond(uid(), chatId, accept));
  on('save:stop', S.saveStop, async ({ chatId }) => svc.saved.stop(uid(), chatId));
}
