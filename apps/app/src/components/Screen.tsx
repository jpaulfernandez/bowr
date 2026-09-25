import { ScrollView, View } from 'react-native';
import { Heading, Text } from './Text';

/** A page with a single h1, a readable measure and reflow down to 320 px. */
export function Screen({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <ScrollView className="flex-1 bg-canvas" contentContainerClassName="grow px-3 py-6 tablet:px-6 desktop:px-8">
      <View className="w-full max-w-content gap-6 self-center">
        <View className="gap-1">
          <Heading level={1}>{title}</Heading>
          {subtitle ? <Text variant="secondary">{subtitle}</Text> : null}
        </View>
        {children}
      </View>
    </ScrollView>
  );
}

export function Prose({ children }: { children: React.ReactNode }) {
  return <View className="max-w-prose gap-4">{children}</View>;
}
