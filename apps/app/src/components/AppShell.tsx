import { Link, usePathname, type Href } from 'expo-router';
import { Text, useWindowDimensions, View } from 'react-native';
import { layout } from '@bowr/design-tokens';
import { SkipLink } from './SkipLink';

type NavItem = { href: Href; label: string; prefixes: string[] };

// Only destinations that exist in this phase are shown; no disabled future tabs.
const items: NavItem[] = [
  { href: '/wardrobe', label: 'Bower', prefixes: ['/wardrobe'] },
  { href: '/more', label: 'More', prefixes: ['/more', '/settings', '/privacy', '/admin', '/onboarding', '/help'] },
];

function isCurrent(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { width } = useWindowDimensions();
  const rail = width >= layout.breakpoints.tablet;

  const nav = (
    <View
      role="navigation"
      aria-label="Main"
      className={
        rail
          ? 'w-rail gap-1 border-r border-divider bg-surface-subtle px-3 py-6 desktop:w-rail-wide'
          : 'flex-row border-t border-divider bg-surface'
      }
    >
      {rail ? <Text className="mb-4 px-3 text-section-title text-text">bowr</Text> : null}
      {items.map((item) => {
        const current = isCurrent(pathname, item.prefixes);
        return (
          <Link
            key={item.label}
            href={item.href}
            aria-current={current ? 'page' : undefined}
            className={`min-h-target justify-center rounded-control px-3 py-2 ${rail ? '' : 'flex-1 items-center'} ${current ? 'bg-accent-soft' : ''}`}
          >
            <Text className={`${rail ? 'text-body' : 'text-compact text-center'} ${current ? 'text-accent underline' : 'text-text'}`}>
              {item.label}
            </Text>
          </Link>
        );
      })}
    </View>
  );

  return (
    <View className={`flex-1 bg-canvas ${rail ? 'flex-row' : 'flex-col'}`}>
      <SkipLink />
      {rail ? nav : null}
      <View role="main" nativeID="main" className="flex-1">
        {children}
      </View>
      {rail ? null : nav}
    </View>
  );
}
