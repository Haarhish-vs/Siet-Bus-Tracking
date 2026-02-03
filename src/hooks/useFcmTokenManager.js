import { useEffect } from 'react';
import { AppState } from 'react-native';
import { authService } from '../services/authService';
import { cleanupNotificationListeners, registerPushTokenAsync } from '../services/pushNotificationService';

export const useFcmTokenManager = (enabled = true) => {
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    let isMounted = true;

    const syncToken = async () => {
      try {
        const user = await authService.getCurrentUser();
        if (!user || !isMounted) {
          return;
        }
        await registerPushTokenAsync(user);
      } catch (error) {
        console.warn('FCM token sync failed', error);
      }
    };

    syncToken();

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        syncToken();
      }
    });

    return () => {
      isMounted = false;
      subscription.remove?.();
      cleanupNotificationListeners();
    };
  }, [enabled]);
};
