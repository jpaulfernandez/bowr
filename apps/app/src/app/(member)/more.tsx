import { Link, type Href } from 'expo-router';
import { Text, View } from 'react-native';
import { Screen } from '../../components/Screen';
import { useBootstrap } from '../../lib/bootstrap';

const entries: Array<{ href: Href; label: string; description: string }> = [
  { href: '/settings', label: 'Settings', description: 'Account, location and units' },
  { href: '/privacy', label: 'Privacy', description: 'How bowr handles your data' },
];

const ownerEntries: typeof entries = [
  { href: '/admin', label: 'Admin', description: 'AI spend, members and invites' },
];

export default function More() {
  const bootstrap = useBootstrap();
  const visible = bootstrap.data?.membership.role === 'owner' ? [...entries, ...ownerEntries] : entries;
  return (
    <Screen title="More">
      <View role="list" className="max-w-prose overflow-hidden rounded-control border border-divider bg-surface">
        {visible.map((entry, index) => (
          <View role="listitem" key={entry.label} className={index > 0 ? 'border-t border-divider' : ''}>
            <Link href={entry.href} className="min-h-target px-4 py-3 hover:bg-surface-subtle">
              <View className="gap-1">
                <Text className="text-action text-accent">{entry.label}</Text>
                <Text className="text-secondary text-text-secondary">{entry.description}</Text>
              </View>
            </Link>
          </View>
        ))}
      </View>
    </Screen>
  );
}
