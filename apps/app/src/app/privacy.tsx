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
          Your wardrobe is private. Other members, including the owner, cannot see your wardrobe or settings. The owner
          can see your display name, who invited you, when you joined and when you last signed in, so they can manage
          access.
        </Text>
        <Text>
          bowr is invite-only. An account that has not entered an invite code within 24 hours of signing up is deleted
          automatically, and you can delete it yourself sooner from the invite screen. Invite codes are stored only as a
          keyed fingerprint, and bowr limits how often codes can be tried.
        </Text>
        <Heading level={2}>Leaving bowr</Heading>
        <Text>
          You can delete your account in Settings. bowr asks you to confirm with a new sign-in, then immediately blocks
          access and deletes your uploads, photos and settings. Stored photos are removed from storage and checked,
          then your sign-in is deleted. Shared AI spend records are kept without your name. The owner can pause a
          member&apos;s access; the member&apos;s data is kept until they delete it.
        </Text>
        <Heading level={2}>This browser</Heading>
        <Text>
          Your session is kept only in this browser tab. Closing the tab signs you out, and you will need a new sign-in
          link. Signing out clears what bowr loaded for your account in this tab.
        </Text>
        <Heading level={2}>Photos</Heading>
        <Text>
          Photos you add are stored privately for your account. Only you can view them, through links that expire after
          a few minutes. The owner cannot see them.
        </Text>
        <Text>
          bowr checks each upload on its own processing service. It keeps a resized copy of the photo with location,
          camera and other embedded details removed, and deletes the file you uploaded after checking it. Uploads that
          are canceled or cannot be used are deleted too.
        </Text>
        <Text>
          Photos you started to upload but never finished are deleted within about an hour after the upload link
          expires.
        </Text>
        <Heading level={2}>Usage events</Heading>
        <Text>
          bowr records a few usage events, such as which screen was opened, how many photos an upload started with,
          and short error codes. They are tied to a random account number, never your email. They never include
          photos, links, anything you type, invite codes or your location, and there is no screen recording.
        </Text>
        <Heading level={2}>Backups</Heading>
        <Text>
          The database is backed up daily and backups are kept for seven days, so deleted account details can remain in
          a backup until it expires. Backups do not contain photos. If a backup is ever restored, deletions made after
          it was taken are applied again before bowr is used.
        </Text>
        <Heading level={2}>Not collected yet</Heading>
        <Text>
          bowr does not yet send your photos or anything you type to an AI provider. The owner can run a diagnostic
          that sends one fixed test sentence with no personal content. This page will change before AI features are
          turned on.
        </Text>
      </Prose>
    </Screen>
  );
}
