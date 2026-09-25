import type { Session } from '@supabase/supabase-js';
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { clearAccountStorage } from './account-storage';
import { supabase } from './supabase';

type SessionState = { status: 'loading'; userId: null } | { status: 'ready'; userId: string | null };

type SessionContextValue = SessionState & {
  /** Ends this tab's session, disposes account caches and returns to the welcome screen. */
  signOut: () => Promise<void>;
  /** Clears a session the server no longer accepts, without navigating. */
  discardSession: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

// The account whose responses may be rendered. Requests capture it when they
// start and discard their result if it changed before they finished.
let currentUserId: string | null = null;
export const getCurrentUserId = () => currentUserId;

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<SessionState>({ status: 'loading', userId: null });

  useEffect(() => {
    let active = true;
    const apply = (session: Session | null) => {
      if (!active) return;
      const nextUserId = session?.user.id ?? null;
      if (nextUserId !== currentUserId) {
        // Account change: stop private work and dispose every cached response
        // before anything renders under the new identity.
        currentUserId = nextUserId;
        void queryClient.cancelQueries();
        queryClient.clear();
      }
      setState({ status: 'ready', userId: nextUserId });
    };

    void supabase.auth.getSession().then(({ data }) => apply(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => apply(session));
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [queryClient]);

  const discardSession = useCallback(async () => {
    await queryClient.cancelQueries();
    queryClient.clear();
    clearAccountStorage();
    await supabase.auth.signOut({ scope: 'local' });
  }, [queryClient]);

  const signOut = useCallback(async () => {
    await discardSession();
    router.replace('/');
  }, [discardSession]);

  const value = useMemo(() => ({ ...state, signOut, discardSession }), [state, signOut, discardSession]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
