/**
 * WebRTC on the web comes from the browser. Phones use react-native-webrtc
 * (see webrtc.native.ts); both expose the same standard API, typed here with
 * the DOM types.
 */
export const RTCPeerConnectionImpl: typeof RTCPeerConnection = globalThis.RTCPeerConnection;

export function getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
  if (!globalThis.navigator?.mediaDevices?.getUserMedia) {
    return Promise.reject(Object.assign(new Error('media_unsupported'), { code: 'media_unsupported' }));
  }
  return navigator.mediaDevices.getUserMedia(constraints);
}

export const webrtcAvailable = typeof globalThis.RTCPeerConnection === 'function';
