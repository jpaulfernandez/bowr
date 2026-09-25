import { RedeemInviteResult } from '@bowr/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { apiRequest } from '../../lib/api';
import { ApiError } from '../../lib/errors';
import { formatTimeFromNow } from '../../lib/format';
import { userKeys } from '../../lib/query-keys';

export function RedeemInviteForm({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const request = useRef<{ key: string; code: string } | null>(null);

  const redeem = useMutation({
    mutationFn: (value: string) => {
      if (!request.current || request.current.code !== value) request.current = { key: crypto.randomUUID(), code: value };
      return apiRequest('/invites/redeem', {
        method: 'POST',
        body: { code: value },
        idempotencyKey: request.current.key,
        schema: RedeemInviteResult,
      });
    },
    onSuccess: async () => {
      request.current = null;
      await queryClient.invalidateQueries({ queryKey: userKeys.bootstrap(userId) });
      router.replace('/onboarding');
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
        const seconds = Number(err.details?.retry_after_seconds ?? 3600);
        setError(`Too many attempts. You can try again after ${formatTimeFromNow(seconds)}.`);
      } else if (err instanceof ApiError && err.code === 'INVITE_UNAVAILABLE') {
        setError("This invite code isn't available. Check it, or ask the owner for a new one.");
      } else {
        setError("bowr couldn't check the code. Try again.");
      }
    },
  });

  const submit = () => {
    const value = code.trim();
    if (!value) {
      setError('Enter the invite code you were given.');
      return;
    }
    setError(null);
    redeem.mutate(value);
  };

  return (
    <View className="max-w-prose gap-4">
      <TextField
        label="Invite code"
        hint="Paste the code exactly as you received it. Dashes and spaces are optional."
        value={code}
        onChangeText={setCode}
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        onSubmitEditing={submit}
        error={error ?? undefined}
      />
      <Button label="Unlock my Bower" busy={redeem.isPending} busyLabel="Checking code" onPress={submit} />
      {error ? <Banner tone="error" message={error} /> : null}
    </View>
  );
}
