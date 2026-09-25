import { View } from 'react-native';
import { Button } from '../components/Button';
import { Prose, Screen } from '../components/Screen';
import { Text } from '../components/Text';
import { TextLink } from '../components/TextLink';
import { useBootstrap } from '../lib/bootstrap';
import { useSession } from '../lib/session';

const copy = {
  pending: {
    title: 'Enter bowr',
    body: 'bowr is invite-only. This account has not been admitted yet. Ask the owner for an invite code.',
  },
  suspended: {
    title: 'Access paused',
    body: 'The owner has paused this account. Your wardrobe is not available while access is paused.',
  },
  deleting: {
    title: 'Account deletion in progress',
    body: 'This account is being deleted. Its data is no longer available.',
  },
} as const;

/** Gate for signed-in identities without active membership. */
export default function Invite() {
  const { signOut } = useSession();
  const bootstrap = useBootstrap();
  const state = bootstrap.data?.membership.state;
  const content = state && state !== 'active' ? copy[state] : copy.pending;

  return (
    <Screen title={content.title}>
      <Prose>
        <Text>{content.body}</Text>
      </Prose>
      <View className="max-w-prose gap-3">
        <Button label="Sign out" variant="secondary" onPress={() => void signOut()} />
        <TextLink href="/privacy">How bowr handles your data</TextLink>
      </View>
    </Screen>
  );
}
