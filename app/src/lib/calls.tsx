import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform, Vibration } from 'react-native';
import { api } from './api';
import { useAuth } from './auth';
import { realtime } from './realtime';
import { getUserMedia, RTCPeerConnectionImpl } from './webrtc';

export type CallInfo = {
  id: string;
  conversationId: string;
  kind: 'audio' | 'video';
  status: 'ringing' | 'accepted' | 'declined' | 'missed' | 'cancelled' | 'ended' | 'busy';
  endReason: string | null;
  direction: 'incoming' | 'outgoing';
  callerDeviceId: string | null;
  calleeDeviceId: string | null;
  peer: { id: string; displayName: string | null; avatarColor: string };
};

/** What the call screen shows. */
export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'connected' | 'ended';

type Signal = { type: 'offer' | 'answer' | 'ice'; sdp?: string; candidate?: RTCIceCandidateInit | null };

type CallState = {
  phase: CallPhase;
  call: CallInfo | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  muted: boolean;
  cameraOff: boolean;
  connectedAt: number | null;
  /** Why the call ended, for the closing message: a call status or an error code. */
  endedBecause: string | null;
};

type CallApi = CallState & {
  startCall: (conversationId: string, kind: 'audio' | 'video') => Promise<void>;
  accept: () => Promise<void>;
  decline: () => Promise<void>;
  hangup: () => Promise<void>;
  toggleMute: () => void;
  toggleCamera: () => void;
};

const initial: CallState = {
  phase: 'idle',
  call: null,
  localStream: null,
  remoteStream: null,
  muted: false,
  cameraOff: false,
  connectedAt: null,
  endedBecause: null,
};

const CallContext = createContext<CallApi | null>(null);

/**
 * Runs one call at a time. The server decides who may call whom and relays
 * connection setup; audio and video then flow directly between the two
 * devices (or through a TURN relay when the network requires it).
 */
export function CallProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const [state, setState] = useState<CallState>(initial);
  const stateRef = useRef(state);
  stateRef.current = state;
  const pc = useRef<RTCPeerConnection | null>(null);
  const iceServers = useRef<RTCIceServer[]>([]);
  const pendingSignals = useRef<Signal[]>([]);
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);
  const myDeviceId = me?.deviceId ?? null;

  const patch = useCallback((p: Partial<CallState>) => setState((s) => ({ ...s, ...p })), []);

  const teardown = useCallback(
    (endedBecause: string | null) => {
      Vibration.cancel();
      pc.current?.close();
      pc.current = null;
      pendingSignals.current = [];
      pendingCandidates.current = [];
      stateRef.current.localStream?.getTracks().forEach((t) => t.stop());
      if (!stateRef.current.call) return setState(initial);
      setState({ ...initial, phase: 'ended', call: stateRef.current.call, endedBecause });
      // The closing message stays briefly, then the call screen disappears.
      setTimeout(() => setState((s) => (s.phase === 'ended' ? initial : s)), 2200);
    },
    [],
  );

  const sendSignal = useCallback((callId: string, signal: Signal) => {
    api('POST', `/calls/${callId}/signal`, signal).catch(() => {});
  }, []);

  const createPeer = useCallback(
    (call: CallInfo, local: MediaStream) => {
      const peer = new RTCPeerConnectionImpl({ iceServers: iceServers.current });
      pc.current = peer;
      local.getTracks().forEach((track) => peer.addTrack(track, local));
      peer.onicecandidate = (e) => {
        if (e.candidate) sendSignal(call.id, { type: 'ice', candidate: e.candidate.toJSON() });
      };
      peer.ontrack = (e) => {
        const stream = e.streams[0] ?? new MediaStream([e.track]);
        patch({ remoteStream: stream });
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'connected') patch({ phase: 'connected', connectedAt: Date.now() });
        if (peer.connectionState === 'failed') {
          // Usually a network that blocks direct connections and no TURN relay is configured.
          api('POST', `/calls/${call.id}/end`).catch(() => {});
          teardown('connection_failed');
        }
      };
      return peer;
    },
    [patch, sendSignal, teardown],
  );

  const applySignal = useCallback(
    async (signal: Signal) => {
      const peer = pc.current;
      const call = stateRef.current.call;
      if (!peer || !call) {
        pendingSignals.current.push(signal);
        return;
      }
      if (signal.type === 'offer' && signal.sdp) {
        await peer.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
        for (const c of pendingCandidates.current.splice(0)) await peer.addIceCandidate(c).catch(() => {});
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        sendSignal(call.id, { type: 'answer', sdp: answer.sdp ?? '' });
      } else if (signal.type === 'answer' && signal.sdp) {
        await peer.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        for (const c of pendingCandidates.current.splice(0)) await peer.addIceCandidate(c).catch(() => {});
      } else if (signal.type === 'ice' && signal.candidate) {
        if (peer.remoteDescription) await peer.addIceCandidate(signal.candidate).catch(() => {});
        else pendingCandidates.current.push(signal.candidate);
      }
    },
    [sendSignal],
  );

  const getMedia = useCallback(async (kind: 'audio' | 'video') => {
    return getUserMedia({ audio: true, video: kind === 'video' ? { facingMode: 'user', width: 640, height: 480 } : false });
  }, []);

  // As the caller: once the other side answers, start the connection with an offer.
  const beginAsCaller = useCallback(
    async (call: CallInfo) => {
      const local = stateRef.current.localStream;
      if (!local || pc.current) return;
      patch({ phase: 'connecting', call });
      const peer = createPeer(call, local);
      const offer = await peer.createOffer({});
      await peer.setLocalDescription(offer);
      sendSignal(call.id, { type: 'offer', sdp: offer.sdp ?? '' });
    },
    [createPeer, patch, sendSignal],
  );

  useEffect(
    () =>
      realtime.subscribe((e) => {
        const current = stateRef.current;
        if (e.type === 'session.revoked') return teardown('ended');
        if (e.type === 'call.incoming') {
          if (current.phase !== 'idle' && current.phase !== 'ended') return; // the server already refuses a second call
          patch({ ...initial, phase: 'incoming', call: e.call });
          if (Platform.OS !== 'web') Vibration.vibrate([0, 700, 900], true);
          return;
        }
        if (e.type === 'call.updated') {
          const call = e.call as CallInfo;
          if (!current.call || current.call.id !== call.id) return;
          if (['declined', 'missed', 'cancelled', 'ended', 'busy'].includes(call.status)) return teardown(call.endReason === 'revoked' ? 'revoked' : call.status);
          if (call.status === 'accepted') {
            if (call.direction === 'outgoing') void beginAsCaller(call).catch(() => teardown('connection_failed'));
            // Answered on another of my devices: stop ringing here.
            else if (call.calleeDeviceId !== myDeviceId && current.phase === 'incoming') setState(initial);
          }
          return;
        }
        if (e.type === 'call.signal' && current.call?.id === e.callId) {
          void applySignal(e.signal).catch(() => teardown('connection_failed'));
        }
      }),
    [applySignal, beginAsCaller, myDeviceId, patch, teardown],
  );

  const startCall = useCallback(
    async (conversationId: string, kind: 'audio' | 'video') => {
      if (stateRef.current.phase !== 'idle' && stateRef.current.phase !== 'ended') return;
      // Ask for the microphone/camera first, so a refusal never rings the other side.
      const local = await getMedia(kind);
      try {
        const r = await api<{ call: CallInfo; iceServers: RTCIceServer[] }>('POST', '/calls', { conversationId, kind });
        iceServers.current = r.iceServers;
        setState({ ...initial, phase: 'outgoing', call: r.call, localStream: local, cameraOff: false });
      } catch (err) {
        local.getTracks().forEach((t) => t.stop());
        throw err;
      }
    },
    [getMedia],
  );

  const accept = useCallback(async () => {
    const call = stateRef.current.call;
    if (!call || stateRef.current.phase !== 'incoming') return;
    Vibration.cancel();
    let local: MediaStream;
    try {
      local = await getMedia(call.kind);
    } catch (err) {
      await api('POST', `/calls/${call.id}/decline`).catch(() => {});
      teardown('media_denied');
      throw err;
    }
    patch({ phase: 'connecting', localStream: local });
    try {
      const r = await api<{ call: CallInfo; iceServers: RTCIceServer[] }>('POST', `/calls/${call.id}/accept`);
      iceServers.current = r.iceServers;
      patch({ call: r.call });
      createPeer(r.call, local);
      for (const s of pendingSignals.current.splice(0)) await applySignal(s);
    } catch (err) {
      teardown('ended');
      throw err;
    }
  }, [applySignal, createPeer, getMedia, patch, teardown]);

  const decline = useCallback(async () => {
    const call = stateRef.current.call;
    if (!call) return;
    await api('POST', `/calls/${call.id}/decline`).catch(() => {});
    teardown('declined');
  }, [teardown]);

  const hangup = useCallback(async () => {
    const call = stateRef.current.call;
    if (!call) return;
    await api('POST', `/calls/${call.id}/end`).catch(() => {});
    teardown('ended');
  }, [teardown]);

  const toggleMute = useCallback(() => {
    const muted = !stateRef.current.muted;
    stateRef.current.localStream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    patch({ muted });
  }, [patch]);

  const toggleCamera = useCallback(() => {
    const cameraOff = !stateRef.current.cameraOff;
    stateRef.current.localStream?.getVideoTracks().forEach((t) => (t.enabled = !cameraOff));
    patch({ cameraOff });
  }, [patch]);

  // Signing out ends any call.
  useEffect(() => {
    if (!me && stateRef.current.call) teardown('ended');
  }, [me, teardown]);

  const value = useMemo(
    () => ({ ...state, startCall, accept, decline, hangup, toggleMute, toggleCamera }),
    [state, startCall, accept, decline, hangup, toggleMute, toggleCamera],
  );
  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

export function useCalls(): CallApi {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error('useCalls outside CallProvider');
  return ctx;
}
