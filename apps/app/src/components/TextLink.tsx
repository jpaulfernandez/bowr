import { Link, type Href } from 'expo-router';
import { Text } from 'react-native';

export function TextLink({ href, children }: { href: Href; children: string }) {
  return (
    <Link href={href} className="min-h-target py-2 text-body text-accent underline">
      <Text className="text-body text-accent underline">{children}</Text>
    </Link>
  );
}
