function initPC(
    onId,
    onClientConnect,
    onClientDisconnect,
    onMessage,
    onError
) {
    const conf = {
        'iceServers': [
            'stun.l.google.com:19302',
            'stun1.l.google.com:19302',
            'stun2.l.google.com:19302',
            'stun3.l.google.com:19302',
            'stun4.l.google.com:19302'
        ].map(s => ({ urls: `stun:${s}` }))
    };

    let socket = null;

    const initialState = () => ({
        id: '',
        master: true,
        targets: []
    });
    let state = initialState();

    const dispatch = a => {
        switch (a.type) {
            case SET_ME:
                state = { ...state, id: a.payload };
                onId(state.id);
                break;
            case SET_TARGET:
                state = {
                    ...state,
                    targets: [
                        ...state.targets,
                        { id: a.payload, candidates: [], pc: null, channel: null }
                    ]
                };
                break;
            case REMOVE_TARGET:
                state = {
                    ...state,
                    targets: state.targets.filter(a => a.id !== a.payload)
                };
                break;
            case RESET:
                state = initialState();
                break;
            case SET_MASTER:
                state = { ...state, master: a.payload };
                break;
            case ADD_CANDIDATE:
                state = {
                    ...state,
                    targets: state.targets.map(t =>
                        t.id === a.payload.id ?
                            { ...t, candidates: [ ...t.candidates, a.payload.candidate ]} :
                            t
                    )
                };
            default:
        }
    };

    const getTarget = id => state.targets.find(t => t.id === id);

    const bindChannel = (target, ch) => {
        target.channel = ch;
        ch.onopen = () => onClientConnect(target.id);
        ch.onclose = () => {
            dispatch({ type: REMOVE_TARGET, payload: target.id });
            onClientDisconnect(target.id);
            ch.onopen = ch.onclose = ch.onmessage = null;
        };
        ch.onmessage = data => onMessage(target.id, data);
    };

    const setupPC = (target) => {
        if (target.pc) return;

        const pc = target.pc = new RTCPeerConnection(conf);

        pc.onicecandidate = ({ candidate }) => {
            if (!candidate) return;

            socket.send({
                to: target.id,
                data: {
                    type: ADD_CANDIDATE,
                    payload: {
                        id: state.id,
                        candidate
                    }
                }
            });
        };

        pc.onnegotiationneeded = async () => {
            if (!state.master) return;

            try {
                await pc.setLocalDescription(await pc.createOffer());

                socket.send({
                    to: target.id,
                    data: {
                        id: state.id,
                        desc: pc.localDescription
                    }
                });
            } catch (err) {
                onError(err);
            }
        };

        pc.oniceconnectionstatechange = function () {
            if (pc.iceConnectionState == 'disconnected') {
                dispatch({ type: REMOVE_TARGET, payload: target.id });
                onClientDisconnect(target.id)
            }
        }

        if (state.master) {
            bindChannel(target, pc.createDataChannel('data'));
        } else {
            pc.ondatachannel = ({ channel }) => bindChannel(getTarget(target.id), channel);
        }
    };

    const setCandidates = id => {
        const { pc, candidates } = getTarget(id);
        while (candidates.length) {
            try {
                pc.addIceCandidate(new RTCIceCandidate(candidates.shift()));
            } catch (e) {
                onError(e);
            }
        }
    }

    socket = io({ upgrade: false, transports: ["websocket"] });
    socket.on("connect", () => console.log("Connected."));
    socket.on("disconnect", () => {
        dispatch({ type: RESET });
        onError({ err: 'disconnected' });
    });
    socket.on("error", console.error);
    socket.on("message", async data => {
        if (data.type) {
            dispatch(data);
            return data.type === SET_TARGET && setupPC(getTarget(data.payload));
        }

        if (data.desc) {
            const { desc, id } = data;
            const { pc } = getTarget(id);
            switch(desc.type) {
                case 'offer':
                    await pc.setRemoteDescription(desc);
                    await pc.setLocalDescription(await pc.createAnswer());
                    socket.send({
                        to: id,
                        data: {
                            id: state.id,
                            desc: pc.localDescription
                        }
                    });
                    setCandidates(id);
                    break;
                case 'answer':
                    await pc.setRemoteDescription(desc);
                    setCandidates(id);
                    break;
                default:
                    onError({ err: 'Unsupported SDP type.' });
            }
        }
    });

    const sendOne = data => ({ channel }) => {
        if (channel) {
            if (channel.readyState === 'open') {
                channel.send(data);
                return;
            }

            onError({ err: `Not ready ${data}, 'channel.readyState: ${channel.readyState}` });
            return;
        }

        onError({ err: 'Channel not initialized.' });
    }

    return {
        getId() { return state.id; },

        connect(targetId) {
            dispatch({
                type: SET_MASTER,
                payload: false // players connect to master
            });

            dispatch({
                type: SET_TARGET,
                payload: targetId
            });

            socket.send({
                to: targetId,
                data: {
                    type: SET_TARGET,
                    payload: state.id
                }
            });

            setupPC(getTarget(targetId));
        },

        send(id, data) {
            sendOne(data)(getTarget(id));
        },

        sendAll(data) {
            state.targets.forEach(sendOne(data));
        }
    };
}
