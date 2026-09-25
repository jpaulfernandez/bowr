import { Slot } from 'expo-router';
import { AppShell } from '../../components/AppShell';
import { useSession } from '../../lib/session';

export default function MemberLayout() {
  const { userId } = useSession();
  // Keyed by account: switching accounts unmounts every private screen and draft.
  return (
    <AppShell key={userId ?? 'none'}>
      <Slot />
    </AppShell>
  );
}
