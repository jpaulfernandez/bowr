import { Prose, Screen } from '../components/Screen';
import { Heading, Text } from '../components/Text';

// Describes behavior implemented today. Update this page in the same change that
// adds photo storage, AI processing, analytics or new retention behavior.
export default function Privacy() {
  return (
    <Screen title="Privacy" subtitle="How bowr handles your data today">
      <Prose>
        <Heading level={2}>Your account</Heading>
        <Text>
          bowr uses Supabase Auth to sign you in with an email link. It stores your email address, your sign-in
          records, and the settings you choose: display name, optional city, timezone, language and units.
        </Text>
        <Text>
          Your wardrobe is private. Other members, including the owner who invited you, cannot see your settings or
          wardrobe. The owner can manage invitations and see membership status.
        </Text>
        <Heading level={2}>This browser</Heading>
        <Text>
          Your session is kept only in this browser tab. Closing the tab signs you out, and you will need a new sign-in
          link. Signing out clears what bowr loaded for your account in this tab.
        </Text>
        <Heading level={2}>Not collected yet</Heading>
        <Text>
          bowr does not yet store photos, send anything to an AI provider, or record usage analytics. This page will
          change before any of those features are turned on.
        </Text>
      </Prose>
    </Screen>
  );
}
