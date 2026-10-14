import { useId } from 'react';
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg';

/** Kesharli mark: a speech bubble holding a heart, with a warm accent dot. */
export function Logo({ size = 72 }: { size?: number }) {
  // Unique per instance: on the web, two logos sharing a gradient id would
  // both point at whichever is first in the document, even if it is hidden.
  const gradientId = 'kg' + useId().replace(/[^a-zA-Z0-9]/g, '');
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" accessibilityLabel="קשרלי">
      <Defs>
        <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#4C8DE6" />
          <Stop offset="1" stopColor="#22B5A7" />
        </LinearGradient>
      </Defs>
      <Path
        d="M50 8C26 8 8 24.5 8 45c0 11.3 5.6 21.4 14.4 28.2L18 91l19.5-10.4c4 1.1 8.2 1.6 12.5 1.6 24 0 42-16.6 42-37.1S74 8 50 8z"
        fill={`url(#${gradientId})`}
      />
      <Path
        d="M50 66s-19-11.4-19-24.2C31 35.4 35.6 31 41.2 31c3.8 0 7 2 8.8 5.1C51.8 33 55 31 58.8 31 64.4 31 69 35.4 69 41.8 69 54.6 50 66 50 66z"
        fill="#FFFFFF"
      />
      <Circle cx="73" cy="24" r="7" fill="#FF9461" />
    </Svg>
  );
}
