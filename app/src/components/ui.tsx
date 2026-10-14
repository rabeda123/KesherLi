import { useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { errorText, t } from '../lib/i18n';
import { font, radius, space, useColors, type Colors } from '../lib/theme';

export function Screen({ children, scroll = true, padded = true }: { children: ReactNode; scroll?: boolean; padded?: boolean }) {
  const c = useColors();
  const inner = <View style={[{ gap: space.lg }, padded && { padding: space.lg }, styles.maxWidth]}>{children}</View>;
  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: c.bg }}>
      {scroll ? (
        <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
          {inner}
        </ScrollView>
      ) : (
        inner
      )}
    </SafeAreaView>
  );
}

export function Title({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  const c = useColors();
  return (
    <View style={{ gap: space.xs }}>
      <Text style={{ fontSize: font.title, fontWeight: '700', color: c.text }}>{children}</Text>
      {sub ? <Text style={{ fontSize: font.body, color: c.textMuted, lineHeight: 22 }}>{sub}</Text> : null}
    </View>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  const c = useColors();
  return (
    <View style={styles.rowBetween}>
      <Text style={{ fontSize: font.small, fontWeight: '700', color: c.textMuted, letterSpacing: 0.3 }}>{children}</Text>
      {action}
    </View>
  );
}

export function Body({ children, muted, style }: { children: ReactNode; muted?: boolean; style?: object }) {
  const c = useColors();
  return <Text style={[{ fontSize: font.body, color: muted ? c.textMuted : c.text, lineHeight: 22 }, style]}>{children}</Text>;
}

export function Card({ children, style, onPress }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void }) {
  const c = useColors();
  const base = [styles.card, { backgroundColor: c.surface, borderColor: c.border, shadowColor: c.shadow }, style];
  if (!onPress) return <View style={base}>{children}</View>;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [base, pressed && { opacity: 0.85 }]} accessibilityRole="button">
      {children}
    </Pressable>
  );
}

type ButtonKind = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  title,
  onPress,
  kind = 'primary',
  disabled,
  loading,
  small,
  icon,
}: {
  title: string;
  onPress: () => void | Promise<void>;
  kind?: ButtonKind;
  disabled?: boolean;
  loading?: boolean;
  small?: boolean;
  icon?: string;
}) {
  const c = useColors();
  const [busy, setBusy] = useState(false);
  const isBusy = loading || busy;
  const palette: Record<ButtonKind, { bg: string; fg: string; border: string }> = {
    primary: { bg: c.primary, fg: c.onPrimary, border: c.primary },
    secondary: { bg: c.primarySoft, fg: c.primary, border: c.primarySoft },
    danger: { bg: c.dangerSoft, fg: c.danger, border: c.dangerSoft },
    ghost: { bg: 'transparent', fg: c.primary, border: 'transparent' },
  };
  const p = palette[kind];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || isBusy }}
      disabled={disabled || isBusy}
      onPress={async () => {
        setBusy(true);
        try {
          await onPress();
        } finally {
          setBusy(false);
        }
      }}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        { backgroundColor: p.bg, borderColor: p.border, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 },
      ]}
    >
      {isBusy ? (
        <ActivityIndicator color={p.fg} />
      ) : (
        <Text style={{ color: p.fg, fontSize: small ? font.small + 1 : font.body, fontWeight: '700' }}>
          {icon ? `${icon}  ` : ''}
          {title}
        </Text>
      )}
    </Pressable>
  );
}

export function Field({ label, hint, ...props }: TextInputProps & { label?: string; hint?: string }) {
  const c = useColors();
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: space.xs }}>
      {label ? <Text style={{ fontSize: font.small + 1, fontWeight: '600', color: c.text }}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={c.textMuted}
        {...props}
        onFocus={(e) => {
          setFocused(true);
          props.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          props.onBlur?.(e);
        }}
        style={[
          styles.input,
          { color: c.text, backgroundColor: c.surface, borderColor: focused ? c.primary : c.border },
          props.multiline && { minHeight: 90, textAlignVertical: 'top' },
          props.style,
        ]}
      />
      {hint ? <Text style={{ fontSize: font.small, color: c.textMuted }}>{hint}</Text> : null}
    </View>
  );
}

export function ToggleRow({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const c = useColors();
  return (
    <View style={[styles.rowBetween, { paddingVertical: space.sm, gap: space.md }]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: font.body, color: c.text }}>{label}</Text>
        {hint ? <Text style={{ fontSize: font.small, color: c.textMuted }}>{hint}</Text> : null}
      </View>
      <Toggle value={value} onChange={onChange} disabled={disabled} label={label} />
    </View>
  );
}

/**
 * A switch drawn by the app rather than the platform's, so it looks the same
 * everywhere and renders correctly in right-to-left layouts on the web.
 */
export function Toggle({ value, onChange, disabled, label }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  const c = useColors();
  return (
    <Pressable
      onPress={() => onChange(!value)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      accessibilityLabel={label}
      hitSlop={8}
      style={{
        width: 50,
        height: 30,
        borderRadius: 15,
        padding: 3,
        backgroundColor: value ? c.teal : c.border,
        opacity: disabled ? 0.5 : 1,
        alignItems: value ? 'flex-end' : 'flex-start',
        justifyContent: 'center',
      }}
    >
      <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: '#FFFFFF', shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 2, shadowOffset: { width: 0, height: 1 }, elevation: 2 }} />
    </Pressable>
  );
}

export function CheckRow({ label, checked, onToggle }: { label: string; checked: boolean; onToggle: () => void }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.md, paddingVertical: space.sm }}
    >
      <View style={[styles.checkbox, { borderColor: checked ? c.teal : c.border, backgroundColor: checked ? c.teal : c.surface }]}>
        {checked ? <Text style={{ color: '#fff', fontWeight: '900', fontSize: 14 }}>✓</Text> : null}
      </View>
      <Text style={{ flex: 1, fontSize: font.body, color: c.text, lineHeight: 22 }}>{label}</Text>
    </Pressable>
  );
}

export function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      style={[styles.chip, { backgroundColor: selected ? c.tealSoft : c.surface, borderColor: selected ? c.teal : c.border }]}
    >
      <Text style={{ color: selected ? c.teal : c.text, fontWeight: selected ? '700' : '500' }}>
        {selected ? '✓ ' : ''}
        {label}
      </Text>
    </Pressable>
  );
}

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info' }) {
  const c = useColors();
  const map = {
    neutral: [c.surfaceAlt, c.textMuted],
    good: [c.successSoft, c.success],
    warn: [c.warmSoft, c.warm],
    bad: [c.dangerSoft, c.danger],
    info: [c.primarySoft, c.primary],
  } as const;
  const [bg, fg] = map[tone];
  return (
    <View style={{ backgroundColor: bg, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3, alignSelf: 'flex-start' }}>
      <Text style={{ color: fg, fontSize: font.small, fontWeight: '700' }}>{label}</Text>
    </View>
  );
}

export function CountBubble({ n }: { n: number }) {
  const c = useColors();
  if (!n) return null;
  return (
    <View style={{ backgroundColor: c.teal, borderRadius: radius.pill, minWidth: 22, height: 22, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 }}>
      <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>{n > 99 ? '99+' : n}</Text>
    </View>
  );
}

export function Avatar({ name, color, size = 46 }: { name: string | null; color: string; size?: number }) {
  const initial = (name ?? '?').trim().charAt(0) || '?';
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: '#fff', fontSize: size * 0.42, fontWeight: '700' }}>{initial}</Text>
    </View>
  );
}

export function ListRow({
  title,
  subtitle,
  left,
  right,
  onPress,
}: {
  title: string;
  subtitle?: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
  onPress?: () => void;
}) {
  const c = useColors();
  const content = (
    <>
      {left}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: font.body, fontWeight: '600', color: c.text }} numberOfLines={1}>
          {title}
        </Text>
        {typeof subtitle === 'string' ? (
          <Text style={{ fontSize: font.small + 1, color: c.textMuted }} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : (
          subtitle
        )}
      </View>
      {right}
    </>
  );
  if (!onPress) return <View style={styles.listRow}>{content}</View>;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.listRow, pressed && { backgroundColor: c.surfaceAlt }]}>
      {content}
    </Pressable>
  );
}

export function Divider() {
  const c = useColors();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border }} />;
}

export function Loading() {
  const c = useColors();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl, backgroundColor: c.bg }}>
      <ActivityIndicator color={c.primary} size="large" />
    </View>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const c = useColors();
  if (!error) return null;
  return (
    <View style={{ backgroundColor: c.dangerSoft, borderRadius: radius.md, padding: space.md, gap: space.sm }} accessibilityRole="alert">
      <Text style={{ color: c.danger, fontSize: font.body }}>{errorText(error)}</Text>
      {onRetry ? <Button title={t('retry')} kind="ghost" small onPress={onRetry} /> : null}
    </View>
  );
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' | 'good' }) {
  const c = useColors();
  const bg = tone === 'warn' ? c.warmSoft : tone === 'good' ? c.successSoft : c.primarySoft;
  const fg = tone === 'warn' ? c.warm : tone === 'good' ? c.success : c.primary;
  return (
    <View style={{ backgroundColor: bg, borderRadius: radius.md, padding: space.md }}>
      <Text style={{ color: fg, fontSize: font.small + 1, lineHeight: 20, fontWeight: '500' }}>{children}</Text>
    </View>
  );
}

export function Empty({ emoji, title, hint, children }: { emoji: string; title: string; hint?: string; children?: ReactNode }) {
  const c = useColors();
  return (
    <View style={{ alignItems: 'center', padding: space.xxl, gap: space.sm }}>
      <Text style={{ fontSize: 44 }}>{emoji}</Text>
      <Text style={{ fontSize: font.large, fontWeight: '700', color: c.text, textAlign: 'center' }}>{title}</Text>
      {hint ? <Text style={{ fontSize: font.body, color: c.textMuted, textAlign: 'center', lineHeight: 22 }}>{hint}</Text> : null}
      {children}
    </View>
  );
}

export function Stat({ value, label, tone, onPress }: { value: number | string; label: string; tone: keyof Colors; onPress?: () => void }) {
  const c = useColors();
  return (
    <Card style={{ flex: 1, minWidth: 100, padding: space.md, gap: 2 }} onPress={onPress}>
      <Text style={{ fontSize: font.hero - 4, fontWeight: '800', color: c[tone] as string }}>{value}</Text>
      <Text style={{ fontSize: font.small, color: c.textMuted }}>{label}</Text>
    </Card>
  );
}

export const styles = StyleSheet.create({
  maxWidth: { width: '100%', maxWidth: 720, alignSelf: 'center' },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  card: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.lg,
    gap: space.md,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 1,
    shadowRadius: 8,
    elevation: 1,
  },
  button: {
    minHeight: 50,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  buttonSmall: { minHeight: 36, paddingHorizontal: space.md, borderRadius: radius.sm },
  // On native, RTL layout already aligns text to the right; on the web we set it explicitly.
  input: { borderWidth: 1.5, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: 12, fontSize: font.body, ...(Platform.OS === 'web' ? { textAlign: 'right' as const } : {}) },
  checkbox: { width: 24, height: 24, borderRadius: 7, borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  chip: { borderWidth: 1.5, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 8 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md, paddingHorizontal: space.xs },
});
