import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Prose, Screen } from '../../components/Screen';
import { Text } from '../../components/Text';
import { sendEmailLink } from '../../features/auth/sign-in';
import { readPendingEmail } from '../../lib/account-storage';

export default function CheckEmail() {
  const [email] = useState(readPendingEmail);
  const [status, setStatus] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const resend = async () => {
    if (!email) return;
    setBusy(true);
    const result = await sendEmailLink(email, null);
    setBusy(false);
    setStatus(result.ok ? { tone: 'success', message: 'A new link is on its way.' } : { tone: 'error', message: result.message });
  };

  return (
    <Screen title="Check your email">
      <Prose>
        <Text>
          {email ? `We sent a sign-in link to ${email}.` : 'We sent you a sign-in link.'} Open it in this browser to
          continue. The link expires after 15 minutes.
        </Text>
      </Prose>
      <View className="max-w-prose gap-3">
        {status ? <Banner tone={status.tone} message={status.message} /> : null}
        {email ? <Button label="Send a new link" variant="secondary" busy={busy} busyLabel="Sending link" onPress={() => void resend()} /> : null}
        <Button label="Use a different email" variant="quiet" onPress={() => router.replace('/auth')} />
      </View>
    </Screen>
  );
}
