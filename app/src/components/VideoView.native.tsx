import type { StyleProp, ViewStyle } from 'react-native';
import { RTCView } from 'react-native-webrtc';

/** Renders a camera stream on phones. Audio plays automatically without a view. */
export function VideoView({ stream, mirror, style }: { stream: MediaStream | null; muted?: boolean; mirror?: boolean; style?: StyleProp<ViewStyle> }) {
  if (!stream) return null;
  const url = (stream as unknown as { toURL(): string }).toURL();
  return <RTCView streamURL={url} objectFit="cover" mirror={mirror} style={[{ width: '100%', height: '100%' }, style]} />;
}
