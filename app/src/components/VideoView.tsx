import { createElement, useEffect, useRef } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

/** Plays a MediaStream on the web with a <video> element (also used for audio-only calls). */
export function VideoView({ stream, muted, mirror, style }: { stream: MediaStream | null; muted?: boolean; mirror?: boolean; style?: StyleProp<ViewStyle> }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return createElement('video', {
    ref,
    autoPlay: true,
    playsInline: true,
    muted,
    style: {
      width: '100%',
      height: '100%',
      objectFit: 'cover',
      transform: mirror ? 'scaleX(-1)' : undefined,
      backgroundColor: '#000',
      ...(style as object),
    },
  });
}
