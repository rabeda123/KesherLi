import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { Share, Text, View } from 'react-native';
import { api } from '../lib/api';
import { displayPhone } from '../lib/format';
import { t, tDynamic } from '../lib/i18n';
import { font, radius, space, useColors } from '../lib/theme';
import type { ApprovalStatus, Permissions } from '../lib/types';
import { Badge, Button, Chip, ErrorBox, Field, Notice } from './ui';

const STATUS_TONE: Record<ApprovalStatus, 'good' | 'warn' | 'bad' | 'info' | 'neutral'> = {
  approved: 'good',
  pending_verification: 'info',
  pending_parent_approval: 'warn',
  rejected: 'neutral',
  blocked: 'bad',
  removed: 'neutral',
};

export function StatusBadge({ status }: { status: ApprovalStatus }) {
  return <Badge label={tDynamic(`status_${status}`)} tone={STATUS_TONE[status]} />;
}

export const PERMISSION_KEYS: Array<keyof Permissions> = ['canMessage', 'canSendMedia', 'canVoice', 'canCall'];
export const DEFAULT_PERMISSIONS: Permissions = { canMessage: true, canSendMedia: false, canVoice: false, canCall: false };

export function PermissionsEditor({ value, onChange }: { value: Permissions; onChange: (p: Permissions) => void }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
      {PERMISSION_KEYS.map((k) => (
        <Chip key={k} label={tDynamic(`perm_${k}`)} selected={value[k]} onPress={() => onChange({ ...value, [k]: !value[k] })} />
      ))}
    </View>
  );
}

/** Shows an invitation link the parent can copy or share with the contact directly. */
export function InviteLinkBox({ link, phone }: { link: string; phone: string }) {
  const c = useColors();
  const [copied, setCopied] = useState(false);
  return (
    <View style={{ gap: space.sm }}>
      <Text style={{ color: c.text, fontSize: font.body }}>{t('inviteSent')}</Text>
      <View style={{ backgroundColor: c.surfaceAlt, borderRadius: radius.sm, padding: space.md }}>
        <Text style={{ color: c.primary, fontSize: font.small }} selectable numberOfLines={2}>
          {link}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <View style={{ flex: 1 }}>
          <Button
            title={copied ? t('copied') : t('copyLink')}
            kind="secondary"
            small
            onPress={async () => {
              await Clipboard.setStringAsync(link);
              setCopied(true);
            }}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button title="שיתוף" kind="secondary" small onPress={() => Share.share({ message: link }).then(() => {}, () => {})} />
        </View>
      </View>
      <Notice>{t('inviteNote', { phone: displayPhone(phone) })}</Notice>
    </View>
  );
}

/**
 * Sensitive actions require proving control of the phone again. This sends
 * a code and returns the proof to pass to the API along with the action.
 */
export function StepUp({ onConfirm, onCancel, confirmLabel }: { onConfirm: (proof: { challengeId: string; code: string }) => Promise<void>; onCancel: () => void; confirmLabel: string }) {
  const [challenge, setChallenge] = useState<{ challengeId: string; devCode?: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const start = async () => {
    setError(null);
    try {
      setChallenge(await api('POST', '/auth/step-up'));
    } catch (err) {
      setError(err);
    }
  };
  return (
    <View style={{ gap: space.md }}>
      {!challenge ? (
        <Button title={t('sendCode')} onPress={start} />
      ) : (
        <>
          <Text style={{ fontWeight: '700' }}>{t('stepUpHint')}</Text>
          {challenge.devCode ? <Notice tone="warn">{t('devCode', { code: challenge.devCode })}</Notice> : null}
          <Field value={code} onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" placeholder="••••••" style={{ textAlign: 'center', letterSpacing: 8, fontSize: 22 }} />
          <Button
            title={confirmLabel}
            kind="danger"
            disabled={code.length !== 6}
            onPress={async () => {
              setError(null);
              try {
                await onConfirm({ challengeId: challenge.challengeId, code });
              } catch (err) {
                setError(err);
              }
            }}
          />
        </>
      )}
      <ErrorBox error={error} />
      <Button title={t('cancel')} kind="ghost" onPress={onCancel} />
    </View>
  );
}
