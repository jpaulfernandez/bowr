import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Prose, Screen } from '../../components/Screen';
import { Text } from '../../components/Text';
import { TextField } from '../../components/TextField';
import { sendEmailLink, startGoogleSignIn } from '../../features/auth/sign-in';
import { readPendingEmail } from '../../lib/account-storage';
import { env } from '../../lib/env';

export default function SignIn() {
  const { returnTo } = useLocalSearchParams<{ returnTo?: string }>();
  const [email, setEmail] = useState(() => readPendingEmail() ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError('Enter a valid email address.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await sendEmailLink(trimmed, returnTo);
    setBusy(false);
    if (result.ok) router.push('/auth/check-email');
    else setError(result.message);
  };

  return (
    <Screen title="Sign in" subtitle={env.googleAuthEnabled ? 'Use Google or a one-time email link.' : 'We will email you a one-time sign-in link.'}>
      <View className="max-w-prose gap-4">
        {env.googleAuthEnabled ? (
          <Button label="Continue with Google" variant="secondary" onPress={() => void startGoogleSignIn(returnTo)} />
        ) : null}
        <TextField
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={() => void submit()}
          error={error ?? undefined}
        />
        <Button label="Email me a sign-in link" busy={busy} busyLabel="Sending link" onPress={() => void submit()} />
        <Prose>
          <Text variant="secondary">
            {"Open the link in this browser. bowr is invite-only; you'll enter your invite after signing in."}
          </Text>
        </Prose>
        {error && !busy ? <Banner tone="error" message={error} /> : null}
      </View>
    </Screen>
  );
}
