const u = {};

module.exports = {
	io: s => {
		u[s.id] = s;
		s.on("disconnect", () => delete u[s.id]);
		s.on("message", data => u[data.to] ?
			u[data.to].send(data.data) :
			s.send({ err: ERR_NOT_FOUND, data }));
		s.on('error', console.error);
		s.send({ type: SET_ME, payload: s.id });
	}
};
