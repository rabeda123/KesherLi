import { Redirect } from 'expo-router';
import { Loading } from '../components/ui';
import { useAuth } from '../lib/auth';

export default function Index() {
  const { ready, token, me } = useAuth();
  if (!ready) return <Loading />;
  if (!token) return <Redirect href="/welcome" />;
  if (me && me.user.kind === 'adult' && !me.user.displayName) return <Redirect href="/profile-setup" />;
  if (me?.user.kind === 'adult' && me.families.length > 0) return <Redirect href="/family" />;
  return <Redirect href="/chats" />;
}
