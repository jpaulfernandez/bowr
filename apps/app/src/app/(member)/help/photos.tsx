import { useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { Prose, Screen } from '../../../components/Screen';
import { Heading, Text } from '../../../components/Text';

type Guide = { id: string; title: string; categories: string[]; how: string[]; watch?: string[] };

// PRD F1 photo guide, reopenable at any time. Framing outlines arrive with the
// native camera in phase 8; this page is the web guidance.
const guides: Guide[] = [
  {
    id: 'hanger',
    title: 'On a hanger',
    categories: ['tops', 'bottoms', 'outerwear', 'dresses'],
    how: [
      'Hang it on a plain door or wall. Button or zip it closed, front facing out.',
      'Use daylight near a window, no flash and no harsh shadows.',
      'Hold the phone upright and level with the piece, straight on.',
      'Keep the whole piece in frame with a little space around it.',
    ],
  },
  {
    id: 'flat-lay',
    title: 'Laid flat',
    categories: ['tops', 'bottoms', 'outerwear', 'dresses'],
    how: [
      'Lay it on a plain sheet or floor: white for dark clothes, darker for light clothes.',
      'Smooth out wrinkles and arrange sleeves and legs naturally.',
      'Shoot straight down from above, phone parallel to the floor. One piece per photo.',
    ],
  },
  {
    id: 'shoes',
    title: 'Shoes',
    categories: ['shoes'],
    how: [
      'Put the pair side by side on the floor, side view with toes pointing left, camera at shoe height.',
      'An optional second shot from above helps.',
    ],
    watch: ['Tidy the laces; wipe the soles if they show.'],
  },
  {
    id: 'shades',
    title: 'Shades and glasses',
    categories: ['eyewear'],
    how: ['Open the arms and lay them on a plain surface. Shoot straight at the lenses from lens height.'],
    watch: ['Reflections: shoot in shade or indirect light and tilt slightly. Use a background that contrasts with the frame.'],
  },
  {
    id: 'hats',
    title: 'Caps and hats',
    categories: ['headwear'],
    how: [
      'Place it on a flat surface, or over a fist or ball to hold the crown’s shape.',
      'Three-quarter front view with the brim toward the camera.',
    ],
    watch: ['Keep the brim flat, not bent out of shape, with the logo facing the camera.'],
  },
  {
    id: 'bags',
    title: 'Bags',
    categories: ['bags'],
    how: ['Stand it upright with the straps above or beside it. Straight-on front view.'],
    watch: ['Stuff it lightly so it holds its shape.'],
  },
  {
    id: 'belts',
    title: 'Belts',
    categories: ['belts'],
    how: ['Lay it straight or loosely coiled with the buckle visible.'],
    watch: ['A plain background lets the edges cut out cleanly.'],
  },
  {
    id: 'jewelry',
    title: 'Watches and jewelry',
    categories: ['watches', 'jewelry'],
    how: ['Place them on dark fabric, close up. Several small pieces can share one photo.'],
    watch: [
      'Glare on metal: use indirect light.',
      'Before pieces are created from a group photo, you choose to keep it as one set or split it into pieces.',
    ],
  },
  {
    id: 'care-labels',
    title: 'Care labels',
    categories: [],
    how: [
      'Photograph the label flat and in focus, filling most of the frame.',
      'In Gather, mark the photo as a care label and choose its piece, or use Add care label on the piece.',
    ],
    watch: [
      'A label is attached to its piece and never becomes a separate piece. It counts toward the 20 photos per upload.',
      'Brand, size and material read from a label never replace details you entered yourself.',
    ],
  },
];

export default function PhotoGuide() {
  const { category } = useLocalSearchParams<{ category?: string }>();
  // Guidance for the piece's category comes first; nothing else is hidden.
  const ordered = [...guides].sort(
    (a, b) => Number(b.categories.includes(category ?? '')) - Number(a.categories.includes(category ?? '')),
  );
  return (
    <Screen title="Photo guide" subtitle="Clear photos make cleaner cutouts and better suggestions.">
      <Prose>
        <Text>
          One piece per photo, against a plain background that contrasts with it, in indirect daylight, with the camera straight on.
          You can retry a cutout, use the original, or fix edges later.
        </Text>
      </Prose>
      {ordered.map((guide) => (
        <View key={guide.id} nativeID={guide.id} className="max-w-prose gap-2">
          <Heading level={2}>{guide.title}</Heading>
          <View role="list" className="gap-2">
            {guide.how.map((line) => (
              <Text key={line} role="listitem">{`• ${line}`}</Text>
            ))}
          </View>
          {guide.watch ? (
            <View className="gap-1">
              <Heading level={3}>Watch out for</Heading>
              {guide.watch.map((line) => (
                <Text key={line}>{line}</Text>
              ))}
            </View>
          ) : null}
        </View>
      ))}
    </Screen>
  );
}
