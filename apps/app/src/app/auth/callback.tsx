import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { LoadingScreen } from '../../components/LoadingScreen';
import { Screen } from '../../components/Screen';
import { takeReturnTo } from '../../lib/account-storage';
import { supabase } from '../../lib/supabase';

type Failure = 'expired' | 'other-browser' | 'failed';

const messages: Record<Failure, string> = {
  expired: 'This sign-in link has expired or was already used.',
  'other-browser': 'Open the sign-in link in the same browser where you asked for it, or request a new link here.',
  failed: "bowr couldn't finish signing you in.",
};

function hashParams(): URLSearchParams {
  return Platform.OS === 'web' ? new URLSearchParams(window.location.hash.replace(/^#/, '')) : new URLSearchParams();
}

function failureFromParams(params: { code?: string; error?: string; error_code?: string }): Failure | null {
  const errorCode = params.error_code ?? hashParams().get('error_code') ?? params.error ?? hashParams().get('error');
  if (errorCode) return errorCode === 'otp_expired' ? 'expired' : 'failed';
  return params.code ? null : 'failed';
}

export default function AuthCallback() {
  const params = useLocalSearchParams<{ code?: string; error?: string; error_code?: string }>();
  const [failure, setFailure] = useState<Failure | null>(() => failureFromParams(params));
  const started = useRef(false);

  useEffect(() => {
    if (failure || started.current || !params.code) return;
    started.current = true;
    void supabase.auth.exchangeCodeForSession(params.code).then(({ error }) => {
      if (error) {
        const missingVerifier = error.name === 'AuthPKCECodeVerifierMissingError' || /code verifier/i.test(error.message);
        setFailure(missingVerifier ? 'other-browser' : error.status === 403 ? 'expired' : 'failed');
        return;
      }
      router.replace((takeReturnTo() ?? '/') as '/');
    });
  }, [failure, params.code]);

  if (!failure) return <LoadingScreen label="Signing you in" />;
  return (
    <Screen title="Sign-in link problem">
      <View className="max-w-prose gap-3">
        <Banner tone="error" message={messages[failure]} />
        <Button label="Send a new link" onPress={() => router.replace('/auth')} />
      </View>
    </Screen>
  );
}
