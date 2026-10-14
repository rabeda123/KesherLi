import { useColorScheme } from 'react-native';

const light = {
  bg: '#F4F7FB',
  surface: '#FFFFFF',
  surfaceAlt: '#EEF3F9',
  primary: '#3A7BD5',
  primarySoft: '#E3EEFB',
  teal: '#22B5A7',
  tealSoft: '#DDF4F1',
  warm: '#FF9461',
  warmSoft: '#FFEDE3',
  text: '#16263A',
  textMuted: '#64758C',
  border: '#E1E8F1',
  danger: '#D93C42',
  dangerSoft: '#FCE8E9',
  success: '#23935F',
  successSoft: '#DFF3E9',
  bubbleMine: '#D9F2EE',
  bubbleOther: '#FFFFFF',
  onPrimary: '#FFFFFF',
  shadow: 'rgba(22, 38, 58, 0.08)',
};

const dark: typeof light = {
  bg: '#0E1621',
  surface: '#17222F',
  surfaceAlt: '#1D2A39',
  primary: '#6EA6F5',
  primarySoft: '#1E3350',
  teal: '#3DD0C1',
  tealSoft: '#173D3B',
  warm: '#FFA779',
  warmSoft: '#43291D',
  text: '#E7EEF6',
  textMuted: '#93A4BA',
  border: '#263548',
  danger: '#FF6B70',
  dangerSoft: '#47212A',
  success: '#4CC98E',
  successSoft: '#163A2B',
  bubbleMine: '#1C4642',
  bubbleOther: '#1D2A39',
  onPrimary: '#0E1621',
  shadow: 'rgba(0, 0, 0, 0.3)',
};

export type Colors = typeof light;

export function useColors(): Colors {
  return useColorScheme() === 'dark' ? dark : light;
}

export const radius = { sm: 10, md: 16, lg: 22, pill: 999 };
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
export const font = { small: 13, body: 16, large: 18, title: 22, hero: 30 };
