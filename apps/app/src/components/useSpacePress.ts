import { useEffect, useRef } from 'react';
import { Platform, type View } from 'react-native';

/**
 * React Native Web presses checkbox-role controls on Enter only; the ARIA
 * checkbox pattern also toggles on Space. Attach the returned ref to the
 * pressable element.
 */
export function useSpacePress(onPress: () => void) {
  const ref = useRef<View>(null);
  useEffect(() => {
    const node = ref.current as unknown as HTMLElement | null;
    if (Platform.OS !== 'web' || !node?.addEventListener) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== ' ' && event.key !== 'Spacebar') return;
      event.preventDefault();
      onPress();
    };
    node.addEventListener('keydown', onKey);
    return () => node.removeEventListener('keydown', onKey);
  }, [onPress]);
  return ref;
}
