import { router } from 'expo-router';
import { View } from 'react-native';
import { Button } from '../components/Button';
import { Prose, Screen } from '../components/Screen';
import { Text } from '../components/Text';
import { TextLink } from '../components/TextLink';
import { startGoogleSignIn } from '../features/auth/sign-in';
import { env } from '../lib/env';

export default function Welcome() {
  return (
    <Screen title="bowr" subtitle="Wear what you've gathered.">
      <Prose>
        <Text>
          bowr keeps a private record of the clothes you own, helps you put outfits together, and remembers what you
          wore.
        </Text>
        <Text>bowr is invite-only. Sign in first, then enter the invite code you were given.</Text>
      </Prose>
      <View className="max-w-prose gap-3">
        {env.googleAuthEnabled ? (
          <Button label="Continue with Google" onPress={() => void startGoogleSignIn(null)} />
        ) : null}
        <Button
          label="Sign in with email"
          variant={env.googleAuthEnabled ? 'secondary' : 'primary'}
          onPress={() => router.push('/auth')}
        />
        <TextLink href="/privacy">How bowr handles your data</TextLink>
      </View>
    </Screen>
  );
}
