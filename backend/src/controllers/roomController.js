export const roomController = (svc) => ({
  list: async (req, res) => res.json({ rooms: await svc.rooms.list({ type: req.query.type }) }),
  mine: async (req, res) => res.json({ rooms: await svc.rooms.mine(String(req.user._id)) }),
  preview: async (req, res) => res.json({ room: await svc.rooms.preview(req.query.code) }),
  create: async (req, res) => res.status(201).json({ room: await svc.rooms.create(req.user, req.body) }),
  remove: async (req, res) => res.json(await svc.rooms.remove(req.user, req.params.id)),
});
