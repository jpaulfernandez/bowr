import { ProfilePatch, ProfileSettings } from '@bowr/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'expo-router';
import { useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { View } from 'react-native';
import { z } from 'zod';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { RadioGroup } from '../../components/RadioGroup';
import { Heading, Text } from '../../components/Text';
import { TextField } from '../../components/TextField';
import { guardedRead, rpc } from '../../lib/api';
import { ApiError } from '../../lib/errors';
import { userKeys } from '../../lib/query-keys';
import { useSession } from '../../lib/session';
import { supabase } from '../../lib/supabase';
import { useBootstrap } from '../../lib/bootstrap';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { startReauth } from './reauth';

const Profile = ProfileSettings.pick({
  display_name: true,
  city: true,
  timezone: true,
  locale: true,
  temperature_unit: true,
  measurement_unit: true,
  revision: true,
});
type Profile = z.infer<typeof Profile>;

type FormValues = {
  display_name: string;
  city: string;
  timezone: string;
  locale: string;
  temperature_unit: Profile['temperature_unit'];
  measurement_unit: Profile['measurement_unit'];
};

const toForm = (profile: Profile): FormValues => ({
  display_name: profile.display_name ?? '',
  city: profile.city ?? '',
  timezone: profile.timezone,
  locale: profile.locale,
  temperature_unit: profile.temperature_unit,
  measurement_unit: profile.measurement_unit,
});

const deviceTimezone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return null;
  }
})();

function useProfile(userId: string) {
  return useQuery({
    queryKey: userKeys.profile(userId),
    queryFn: async ({ signal }) =>
      Profile.parse(
        await guardedRead(() =>
          supabase
            .from('profiles')
            .select('display_name, city, timezone, locale, temperature_unit, measurement_unit, revision')
            .abortSignal(signal)
            .single(),
        ),
      ),
  });
}

export function SettingsForm() {
  const { userId } = useSession();
  return userId ? <AccountSettings userId={userId} /> : null;
}

function AccountSettings({ userId }: { userId: string }) {
  const { signOut } = useSession();
  const profile = useProfile(userId);

  return (
    <View className="max-w-prose gap-8">
      {profile.isPending ? <Text variant="secondary">Loading your settings</Text> : null}
      {profile.isError ? (
        <Banner tone="error" message="Your settings couldn't load.">
          <Button label="Try again" variant="secondary" onPress={() => void profile.refetch()} />
        </Banner>
      ) : null}
      {profile.data ? <ProfileEditor userId={userId} profile={profile.data} /> : null}
      <AccountSection onSignOut={() => void signOut()} />
    </View>
  );
}

function ProfileEditor({ userId, profile }: { userId: string; profile: Profile }) {
  const queryClient = useQueryClient();
  const form = useForm<FormValues>({ defaultValues: toForm(profile) });
  const [status, setStatus] = useState<{ tone: 'success' | 'error'; message: string; conflict?: boolean } | null>(null);
  // One request identity per save attempt; reused only when retrying the same body.
  const pending = useRef<{ key: string; body: string } | null>(null);

  const save = useMutation({
    mutationFn: async (patch: ProfilePatch) => {
      const body = JSON.stringify({ revision: profile.revision, patch });
      if (!pending.current || pending.current.body !== body) pending.current = { key: crypto.randomUUID(), body };
      return rpc(
        'update_profile',
        { p_request_id: pending.current.key, p_expected_revision: profile.revision, p_patch: patch },
        Profile,
      );
    },
    onSuccess: (saved) => {
      pending.current = null;
      queryClient.setQueryData(userKeys.profile(userId), saved);
      void queryClient.invalidateQueries({ queryKey: userKeys.bootstrap(userId) });
      form.reset(toForm(saved));
      setStatus({ tone: 'success', message: 'Settings saved.' });
    },
    onError: (error) => {
      if (error instanceof ApiError && !error.retryable) pending.current = null;
      if (error instanceof ApiError && error.code === 'REVISION_CONFLICT') {
        setStatus({ tone: 'error', message: 'These settings changed somewhere else.', conflict: true });
      } else if (error instanceof ApiError && error.code === 'VALIDATION_FAILED') {
        setStatus({ tone: 'error', message: 'Check the values and try again.' });
      } else {
        setStatus({ tone: 'error', message: "Settings haven't saved yet. Your changes are still here." });
      }
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    const saved = toForm(profile);
    const candidate = Object.fromEntries(
      (Object.keys(values) as Array<keyof FormValues>)
        .filter((key) => values[key] !== saved[key])
        .map((key) => [key, values[key]]),
    );
    if (Object.keys(candidate).length === 0) {
      setStatus({ tone: 'success', message: 'Nothing to save.' });
      return;
    }
    const parsed = ProfilePatch.safeParse(candidate);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        form.setError(issue.path[0] as keyof FormValues, { message: issue.message });
      }
      return;
    }
    setStatus(null);
    save.mutate(parsed.data);
  });

  const reload = async () => {
    pending.current = null;
    const fresh = await queryClient.fetchQuery({ queryKey: userKeys.profile(userId), staleTime: 0 });
    form.reset(toForm(fresh as Profile));
    setStatus(null);
  };

  return (
    <View className="gap-6">
      <View className="gap-4">
        <Heading level={2}>Profile</Heading>
        <Controller
          control={form.control}
          name="display_name"
          render={({ field, fieldState }) => (
            <TextField
              label="Display name"
              hint="Shown to you and, for support, to the owner."
              value={field.value}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
              maxLength={80}
              autoComplete="name"
              error={fieldState.error?.message}
            />
          )}
        />
      </View>
      <View className="gap-4">
        <Heading level={2}>Location and units</Heading>
        <Controller
          control={form.control}
          name="city"
          render={({ field, fieldState }) => (
            <TextField
              label="City (optional)"
              hint="Used later for weather. bowr never asks for precise location."
              value={field.value}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
              maxLength={80}
              error={fieldState.error?.message}
            />
          )}
        />
        <Controller
          control={form.control}
          name="timezone"
          render={({ field, fieldState }) => (
            <View className="gap-2">
              <TextField
                label="Timezone"
                hint="An IANA name such as Asia/Manila. Fit dates use this timezone."
                value={field.value}
                onChangeText={field.onChange}
                onBlur={field.onBlur}
                autoCapitalize="none"
                autoCorrect={false}
                error={fieldState.error?.message}
              />
              {deviceTimezone && deviceTimezone !== field.value ? (
                <Button
                  label={`Use this device's timezone (${deviceTimezone})`}
                  variant="quiet"
                  onPress={() => form.setValue('timezone', deviceTimezone, { shouldDirty: true })}
                />
              ) : null}
            </View>
          )}
        />
        <Controller
          control={form.control}
          name="locale"
          render={({ field }) => (
            <RadioGroup
              label="Date and number format"
              value={field.value}
              onChange={(value) => field.onChange(value)}
              options={[
                { value: 'en', label: 'Default' },
                { value: 'en-PH', label: 'English (Philippines)' },
                { value: 'en-US', label: 'English (US)' },
                { value: 'en-GB', label: 'English (UK)' },
              ]}
            />
          )}
        />
        <Controller
          control={form.control}
          name="temperature_unit"
          render={({ field }) => (
            <RadioGroup
              label="Temperature"
              value={field.value}
              onChange={(value) => field.onChange(value)}
              options={[
                { value: 'celsius', label: 'Celsius' },
                { value: 'fahrenheit', label: 'Fahrenheit' },
              ]}
            />
          )}
        />
        <Controller
          control={form.control}
          name="measurement_unit"
          render={({ field }) => (
            <RadioGroup
              label="Measurements"
              value={field.value}
              onChange={(value) => field.onChange(value)}
              options={[
                { value: 'metric', label: 'Metric' },
                { value: 'imperial', label: 'Imperial' },
              ]}
            />
          )}
        />
      </View>
      {status ? (
        <Banner tone={status.tone} message={status.message}>
          {status.conflict ? <Button label="Reload settings" variant="secondary" onPress={() => void reload()} /> : null}
        </Banner>
      ) : null}
      <Button label="Save settings" busy={save.isPending} busyLabel="Saving" onPress={() => void onSubmit()} />
    </View>
  );
}

function AccountSection({ onSignOut }: { onSignOut: () => void }) {
  const bootstrap = useBootstrap();
  const identity = useQuery({
    queryKey: ['auth-identity'],
    queryFn: async () => (await supabase.auth.getUser()).data.user,
    staleTime: Infinity,
  });
  const [confirming, setConfirming] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () => startReauth('delete_account'),
    onSuccess: (result) => {
      setConfirming(false);
      setSent(
        result.via === 'email'
          ? `We sent a confirmation link to ${result.email}. Open it in this browser to finish deleting your account.`
          : 'Continue with Google to confirm.',
      );
    },
    onError: () => {
      setConfirming(false);
      setError("bowr couldn't start the confirmation. Try again.");
    },
  });
  const isOwner = bootstrap.data?.membership.role === 'owner';
  const provider = identity.data?.app_metadata.provider === 'google' ? 'Google' : 'Email link';

  return (
    <View className="gap-3">
      <Heading level={2}>Account</Heading>
      {identity.data?.email ? <Text variant="secondary">{`Signed in with ${provider} as ${identity.data.email}`}</Text> : null}
      <Button label="Sign out" variant="secondary" onPress={onSignOut} />
      <Link href="/privacy" className="min-h-target self-start py-3 text-action text-accent underline">
        How bowr handles your data
      </Link>
      <Heading level={3}>Delete account</Heading>
      <Text variant="secondary">
        {isOwner
          ? 'You are the owner. If other members are active, transfer ownership in Admin before deleting your account.'
          : 'Deleting your account removes your wardrobe, photos and settings.'}
      </Text>
      {sent ? <Banner tone="info" message={sent} /> : null}
      {error ? <Banner tone="error" message={error} /> : null}
      <Button label="Delete my account" variant="destructive" onPress={() => setConfirming(true)} />
      <ConfirmDialog
        visible={confirming}
        title="Delete your account?"
        consequences={[
          'Your pieces, photos, uploads and settings will be permanently deleted.',
          'Other members keep their accounts. Shared AI spend records stay without your name.',
          'To confirm, we will send a new sign-in link to your email. Deletion happens only after you open it.',
        ]}
        confirmLabel="Send confirmation link"
        destructive
        busy={start.isPending}
        onConfirm={() => start.mutate()}
        onCancel={() => setConfirming(false)}
      />
    </View>
  );
}
