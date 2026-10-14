import { RTCPeerConnection as NativePeerConnection, mediaDevices } from 'react-native-webrtc';

// react-native-webrtc implements the standard WebRTC API; it needs a
// development or production build (it is not part of Expo Go).
export const RTCPeerConnectionImpl = NativePeerConnection as unknown as typeof RTCPeerConnection;

export function getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
  return mediaDevices.getUserMedia(constraints as never) as unknown as Promise<MediaStream>;
}

export const webrtcAvailable = true;
