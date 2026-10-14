import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useCalls } from '../lib/calls';
import { inform } from '../lib/dialog';
import { errorText, t, tDynamic } from '../lib/i18n';
import { Avatar } from './ui';
import { VideoView } from './VideoView';

function useElapsed(since: number | null): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);
  if (!since) return '';
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function RoundButton({ icon, label, color, onPress, active, tilt }: { icon: keyof typeof Ionicons.glyphMap; label: string; color: string; onPress: () => void; active?: boolean; tilt?: boolean }) {
  return (
    <View style={{ alignItems: 'center', gap: 6 }}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={({ pressed }) => [styles.round, { backgroundColor: color, opacity: pressed ? 0.8 : 1 }, active && { borderWidth: 3, borderColor: '#fff' }]}
      >
        <Ionicons name={icon} size={30} color="#fff" style={tilt ? { transform: [{ rotate: '135deg' }] } : undefined} />
      </Pressable>
      <Text style={styles.btnLabel}>{label}</Text>
    </View>
  );
}

/** Full-screen call UI shown above every screen while a call rings, connects or runs. */
export function CallOverlay() {
  const calls = useCalls();
  const { phase, call, localStream, remoteStream, muted, cameraOff, connectedAt, endedBecause } = calls;
  const elapsed = useElapsed(phase === 'connected' ? connectedAt : null);
  if (phase === 'idle' || !call) return null;

  const isVideo = call.kind === 'video';
  const name = call.peer.displayName ?? '';
  const showRemoteVideo = isVideo && phase === 'connected' && remoteStream;
  const run = (fn: () => Promise<void>) => () => fn().catch((err) => inform(errorText(err)));

  const status =
    phase === 'incoming'
      ? isVideo
        ? t('callIncomingVideo')
        : t('callIncomingAudio')
      : phase === 'outgoing'
        ? t('callRinging')
        : phase === 'connecting'
          ? t('callConnecting')
          : phase === 'connected'
            ? elapsed
            : tDynamic(`callEnded_${endedBecause}`, undefined, t('callEnded_ended'));

  return (
    <View style={[StyleSheet.absoluteFill, styles.root]} accessibilityViewIsModal>
      {showRemoteVideo ? <VideoView stream={remoteStream} style={StyleSheet.absoluteFill} /> : null}
      {/* Audio-only calls still need a player for the remote sound on the web. */}
      {!showRemoteVideo && remoteStream && Platform.OS === 'web' ? (
        <View style={{ width: 1, height: 1, opacity: 0, position: 'absolute' }}>
          <VideoView stream={remoteStream} />
        </View>
      ) : null}
      <SafeAreaView style={{ flex: 1, justifyContent: 'space-between' }}>
        <View style={[{ alignItems: 'center', gap: 12, paddingTop: 48, paddingBottom: 16 }, showRemoteVideo && styles.scrim]}>
          {!showRemoteVideo ? <Avatar name={name} color={call.peer.avatarColor} size={112} /> : null}
          <Text style={styles.name} accessibilityRole="header">
            {name}
          </Text>
          <Text style={styles.status} accessibilityLiveRegion="polite">
            {isVideo ? '🎥 ' : '📞 '}
            {status}
          </Text>
        </View>

        {isVideo && localStream && !cameraOff && phase !== 'ended' ? (
          <View style={styles.pip}>
            <VideoView stream={localStream} muted mirror />
          </View>
        ) : null}

        <View style={[styles.controls, showRemoteVideo && styles.scrim, showRemoteVideo && { paddingTop: 16 }]}>
          {phase === 'incoming' ? (
            <>
              <RoundButton icon="close" label={t('callDecline')} color="#E5484D" onPress={run(calls.decline)} />
              <RoundButton icon={isVideo ? 'videocam' : 'call'} label={t('callAccept')} color="#23935F" onPress={run(calls.accept)} />
            </>
          ) : phase === 'ended' ? null : (
            <>
              <RoundButton icon={muted ? 'mic-off' : 'mic'} label={muted ? t('callUnmute') : t('callMute')} color="rgba(255,255,255,0.18)" active={muted} onPress={calls.toggleMute} />
              {isVideo ? (
                <RoundButton
                  icon={cameraOff ? 'videocam-off' : 'videocam'}
                  label={cameraOff ? t('callCameraOn') : t('callCameraOff')}
                  color="rgba(255,255,255,0.18)"
                  active={cameraOff}
                  onPress={calls.toggleCamera}
                />
              ) : null}
              <RoundButton icon="call" label={t('callHangup')} color="#E5484D" tilt onPress={run(calls.hangup)} />
            </>
          )}
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: '#0E1621', zIndex: 1000 },
  name: { color: '#fff', fontSize: 28, fontWeight: '800', textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 6 },
  status: { color: 'rgba(255,255,255,0.85)', fontSize: 17, textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 6 },
  scrim: { backgroundColor: 'rgba(0,0,0,0.45)' },
  controls: { flexDirection: 'row', justifyContent: 'space-evenly', paddingBottom: 48, paddingHorizontal: 24 },
  round: { width: 68, height: 68, borderRadius: 34, alignItems: 'center', justifyContent: 'center' },
  btnLabel: { color: '#fff', fontSize: 13, fontWeight: '600' },
  pip: {
    position: 'absolute',
    top: 96,
    end: 16,
    width: 110,
    height: 150,
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.6)',
  },
});
