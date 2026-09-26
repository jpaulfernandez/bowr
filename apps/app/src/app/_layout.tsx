import '../../global.css';
import { routeTemplate } from '@bowr/contracts';
import { decideRoute, type Gate as RouteGate } from '@bowr/domain';
import { QueryClientProvider } from '@tanstack/react-query';
import { Redirect, Slot, usePathname, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { LoadingScreen } from '../components/LoadingScreen';
import { installErrorReporting, track } from '../lib/analytics';
import { useBootstrap } from '../lib/bootstrap';
import { ApiError } from '../lib/errors';
import { createQueryClient } from '../lib/query-client';
import { SessionProvider, useSession } from '../lib/session';

export default function RootLayout() {
  const [queryClient] = useState(createQueryClient);
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <Gate>
            <Slot />
          </Gate>
        </SessionProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

/**
 * Resolves Auth, then bootstrap, before rendering any route. The server enforces
 * access; this only chooses which layout the identity may see.
 */
function Gate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const session = useSession();
  const bootstrap = useBootstrap();
  useEffect(() => installErrorReporting(), []);
  useEffect(() => {
    track({ event: 'screen_viewed', properties: { route: routeTemplate(pathname) } });
  }, [pathname]);

  const sessionRejected =
    session.userId !== null && bootstrap.error instanceof ApiError && bootstrap.error.code === 'AUTH_REQUIRED';

  useEffect(() => {
    // The server no longer accepts this session (revoked or deleted): drop it locally.
    if (sessionRejected) void session.discardSession();
  }, [sessionRejected, session]);

  if (session.status === 'loading' || sessionRejected) return <LoadingScreen />;
  if (session.userId && bootstrap.isPending) return <LoadingScreen />;
  if (session.userId && bootstrap.isError) {
    return (
      <View className="flex-1 justify-center bg-canvas p-4">
        <View className="w-full max-w-prose gap-4 self-center">
          <Banner tone="error" message="bowr couldn't load your account. Your data is safe." />
          <Button label="Try again" onPress={() => void bootstrap.refetch()} />
          <Button label="Sign out" variant="secondary" onPress={() => void session.signOut()} />
        </View>
      </View>
    );
  }

  const gate: RouteGate =
    session.userId && bootstrap.data
      ? { kind: 'signed-in', state: bootstrap.data.membership.state, role: bootstrap.data.membership.role }
      : { kind: 'anonymous' };
  const decision = decideRoute(pathname, gate);
  if (decision.type === 'redirect') return <Redirect href={decision.to as Href} />;
  return <>{children}</>;
}
