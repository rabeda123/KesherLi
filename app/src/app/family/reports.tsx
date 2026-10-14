import { Stack } from 'expo-router';
import { Text, View } from 'react-native';
import { Badge, Body, Button, Card, Empty, ErrorBox, Loading, Screen, styles } from '../../components/ui';
import { api } from '../../lib/api';
import { useFamily } from '../../lib/auth';
import { inform } from '../../lib/dialog';
import { formatDateTime } from '../../lib/format';
import { errorText, t, tDynamic } from '../../lib/i18n';
import { font, radius, space, useColors } from '../../lib/theme';
import { useQuery } from '../../lib/useQuery';

type Report = {
  id: string;
  reason: string;
  details: string | null;
  status: 'open' | 'resolved';
  createdAt: string;
  reporterName: string | null;
  messageBody: string | null;
  messageSender: string | null;
};

export default function Reports() {
  const c = useColors();
  const family = useFamily();
  const { data, error, loading, reload } = useQuery<{ reports: Report[] }>(family ? `/families/${family.id}/reports` : null, ['notification.new']);
  if (!family) return null;
  if (loading && !data) return <Loading />;

  return (
    <Screen>
      <Stack.Screen options={{ title: t('reports') }} />
      <ErrorBox error={error} onRetry={reload} />
      {data?.reports.length === 0 ? <Empty emoji="🕊️" title={t('reportsEmpty')} /> : null}
      {data?.reports.map((r) => (
        <Card key={r.id} style={r.status === 'resolved' ? { opacity: 0.65 } : undefined}>
          <View style={styles.rowBetween}>
            <Text style={{ fontSize: font.large, fontWeight: '700', color: c.text }}>{tDynamic(`reason_${r.reason}`)}</Text>
            <Badge label={r.status === 'open' ? t('openReports') : t('resolved')} tone={r.status === 'open' ? 'bad' : 'neutral'} />
          </View>
          <Body muted>
            {r.reporterName} · {formatDateTime(r.createdAt)}
          </Body>
          {r.details ? <Body>{r.details}</Body> : null}
          {r.messageBody ? (
            <View style={{ backgroundColor: c.surfaceAlt, borderRadius: radius.sm, padding: space.md }}>
              <Text style={{ color: c.textMuted, fontSize: font.small }}>{r.messageSender}</Text>
              <Text style={{ color: c.text }}>{r.messageBody}</Text>
            </View>
          ) : null}
          {r.status === 'open' ? (
            <Button
              title={t('resolve')}
              kind="secondary"
              small
              onPress={async () => {
                try {
                  await api('POST', `/families/${family.id}/reports/${r.id}/resolve`);
                  await reload();
                } catch (err) {
                  inform(errorText(err));
                }
              }}
            />
          ) : null}
        </Card>
      ))}
    </Screen>
  );
}
