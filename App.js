import React, { useEffect, useRef, useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import { View, ActivityIndicator, Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  useFonts,
  Poppins_300Light,
  Poppins_400Regular,
  Poppins_500Medium,
  Poppins_600SemiBold,
  Poppins_700Bold,
} from '@expo-google-fonts/poppins';
import * as SplashScreen from 'expo-splash-screen';
import AppNavigator from './src/navigation/AppNavigator';
import {
  getInitialNotification,
  subscribeToForegroundNotifications,
  subscribeToNotificationOpens,
} from './src/services/pushNotificationService';
import { useFcmTokenManager } from './src/hooks/useFcmTokenManager';

const BUS_UPDATE_FALLBACK_TITLE = 'SIET Bus Update';
const BUS_UPDATE_FALLBACK_BODY = 'A new bus notification is available.';

SplashScreen.preventAutoHideAsync().catch(() => null);

export default function App() {
  const [appIsReady, setAppIsReady] = useState(false);
  const [fontsLoaded] = useFonts({
    Poppins_300Light,
    Poppins_400Regular,
    Poppins_500Medium,
    Poppins_600SemiBold,
    Poppins_700Bold,
  });

  const foregroundSubscriptionRef = useRef(null);
  const notificationOpenSubscriptionRef = useRef(null);

  useFcmTokenManager();

  useEffect(() => {
    if (!fontsLoaded) {
      return undefined;
    }

    let isMounted = true;

    const initializeApp = async () => {
      try {
        foregroundSubscriptionRef.current = subscribeToForegroundNotifications((remoteMessage) => {
          const title = remoteMessage?.notification?.title || BUS_UPDATE_FALLBACK_TITLE;
          const body = remoteMessage?.notification?.body || BUS_UPDATE_FALLBACK_BODY;
          Alert.alert(title, body);
        });

        notificationOpenSubscriptionRef.current = subscribeToNotificationOpens((remoteMessage) => {
          if (__DEV__ && remoteMessage?.data) {
            console.log('Notification opened:', remoteMessage.data);
          }
        });

        await getInitialNotification();

        if (isMounted) {
          setAppIsReady(true);
        }
      } catch (error) {
        console.warn('Startup warning:', error);
        if (isMounted) {
          setAppIsReady(true);
        }
      } finally {
        if (isMounted) {
          try {
            await SplashScreen.hideAsync();
          } catch (splashError) {
            console.warn('Splash screen hide failed', splashError);
          }
        }
      }
    };

    initializeApp();

    return () => {
      isMounted = false;
      foregroundSubscriptionRef.current?.();
      notificationOpenSubscriptionRef.current?.();
      foregroundSubscriptionRef.current = null;
      notificationOpenSubscriptionRef.current = null;
    };
  }, [fontsLoaded]);

  if (!fontsLoaded || !appIsReady) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' }}>
        <ActivityIndicator size="large" color="#2E7D32" />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <AppNavigator />
        <StatusBar style="auto" />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}