import messaging from '@react-native-firebase/messaging';
import { Alert, PermissionsAndroid, Platform } from 'react-native';
import { arrayRemove, arrayUnion, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { db } from './firebaseConfig';
import { postJson } from './backendClient';
import { normalizeBusNumber } from '../utils/busNumber';

const AUTHORIZED_STATUSES = [
  messaging.AuthorizationStatus.AUTHORIZED,
  messaging.AuthorizationStatus.PROVISIONAL,
];

let tokenRefreshUnsubscribe = null;
let cachedToken = null;

const resolveUserIdentifier = (user) => user?.uid || user?.id || user?.userId || null;

async function ensureAndroidNotificationPermission() {
  if (Platform.OS !== 'android') {
    return true;
  }

  const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
  if (!permission) {
    return true;
  }

  const hasPermission = await PermissionsAndroid.check(permission);
  if (hasPermission) {
    return true;
  }

  const status = await PermissionsAndroid.request(permission);
  return status === PermissionsAndroid.RESULTS.GRANTED;
}

async function ensureMessagingPermission() {
  try {
    const status = await messaging().hasPermission();
    if (AUTHORIZED_STATUSES.includes(status)) {
      return true;
    }

    const androidGranted = await ensureAndroidNotificationPermission();
    if (!androidGranted) {
      return false;
    }

    const newStatus = await messaging().requestPermission();
    return AUTHORIZED_STATUSES.includes(newStatus);
  } catch (error) {
    console.warn('Unable to confirm messaging permission', error);
    return false;
  }
}

async function persistTokenForUser({ identifier, token, user }) {
  const baseDoc = doc(db, 'users', identifier);
  const normalizedBusNumber = normalizeBusNumber(user?.busNumber ?? user?.busId ?? null);
  const userRecord = {
    role: user?.role || 'student',
    // Normalize busNumber so server lookups match the driver's normalized bus id
    busNumber: normalizedBusNumber || null,
    updatedAt: new Date().toISOString(),
  };

  await setDoc(baseDoc, userRecord, { merge: true });

  try {
    await updateDoc(baseDoc, {
      fcmTokens: arrayUnion(token),
      lastFcmToken: token,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.warn('Falling back to setDoc merge for token union', error);
    await setDoc(
      baseDoc,
      {
        fcmTokens: arrayUnion(token),
        lastFcmToken: token,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  }

  cachedToken = token;
}

function registerTokenRefreshListener(user) {
  if (tokenRefreshUnsubscribe || !user) {
    return;
  }

  const identifier = resolveUserIdentifier(user);
  if (!identifier) {
    return;
  }

  tokenRefreshUnsubscribe = messaging().onTokenRefresh(async (newToken) => {
    try {
      await persistTokenForUser({ identifier, token: newToken, user });
      console.info('Updated refreshed FCM token for user', identifier);
    } catch (error) {
      console.warn('Failed to update refreshed FCM token', error);
    }
  });
}

export async function registerPushTokenAsync(user) {
  if (!user) {
    console.warn('[FCM] registerPushTokenAsync skipped: user context missing');
    return null;
  }

  const identifier = resolveUserIdentifier(user);
  if (!identifier) {
    console.warn('[FCM] Unable to persist token: missing user identifier', user);
    return null;
  }

  try {
    console.info('[FCM] Requesting notification permission for', identifier);
    const permissionGranted = await ensureMessagingPermission();
    console.info('[FCM] Permission result', { identifier, permissionGranted });

    if (!permissionGranted) {
      Alert.alert(
        'Notifications Disabled',
        'Enable notifications in system settings to receive live bus alerts.'
      );
      return null;
    }

    await messaging().setAutoInitEnabled(true);
    const deviceToken = await messaging().getToken();
    console.info('[FCM] messaging().getToken() result', {
      identifier,
      hasToken: Boolean(deviceToken),
    });

    if (!deviceToken) {
      console.warn('[FCM] Empty token received; aborting save', identifier);
      return null;
    }

    console.info('[FCM] Persisting token to Firestore', {
      identifier,
      tokenPreview: `${deviceToken.slice(0, 10)}…`,
    });

    try {
      await persistTokenForUser({ identifier, token: deviceToken, user });
      console.info('[FCM] Token persisted successfully', identifier);
    } catch (persistError) {
      console.error('[FCM] Failed to persist token', { identifier, persistError });
      return null;
    }

    registerTokenRefreshListener(user);
    return deviceToken;
  } catch (error) {
    console.error('[FCM] registerPushTokenAsync failed', { identifier, error });
    return null;
  }
}

export async function removePushTokenForUser(user) {
  try {
    const identifier = resolveUserIdentifier(user);
    if (!identifier) {
      return;
    }

    // Try to use the cached token; if missing, fetch current token
    let token = cachedToken;
    try {
      if (!token) {
        token = await messaging().getToken();
      }
    } catch (err) {
      // ignore fetch errors
    }

    const baseDoc = doc(db, 'users', identifier);
    const payload = {
      updatedAt: new Date().toISOString(),
    };

    const updates = [];
    if (token) {
      updates.push(
        updateDoc(baseDoc, {
          ...payload,
          fcmTokens: arrayRemove(token),
        }).catch(async () => {
          await setDoc(
            baseDoc,
            {
              ...payload,
              fcmTokens: arrayRemove(token),
            },
            { merge: true }
          );
        })
      );
    }

    updates.push(
      updateDoc(baseDoc, {
        lastFcmToken: null,
        updatedAt: new Date().toISOString(),
      }).catch(async () => {
        await setDoc(
          baseDoc,
          {
            lastFcmToken: null,
            updatedAt: new Date().toISOString(),
          },
          { merge: true }
        );
      })
    );

    await Promise.all(updates);

    try {
      if (token) {
        await messaging().deleteToken(token);
      } else {
        await messaging().deleteToken();
      }
    } catch (deleteError) {
      console.warn('Failed to delete FCM token locally', deleteError);
    }
  } catch (error) {
    console.warn('Failed to remove push token on logout', error);
  }
}

export async function notifyBusTrackingStarted({
  busNumber,
  driverName,
  excludeUid = null,
  excludeToken = null,
}) {
  if (!busNumber) {
    throw new Error('busNumber is required to trigger bus start notifications');
  }

  const payload = {
    busNumber,
    driverName,
    initiatedBy: excludeUid || null,
    excludeToken: excludeToken || null,
  };

  return postJson('/startBus', payload);
}

export async function sendUserNotification({ recipientUid, title, body, data }) {
  if (!recipientUid) {
    throw new Error('recipientUid is required for direct notifications');
  }

  return postJson('/notify', {
    recipientUid,
    title,
    body,
    data,
  });
}

export function subscribeToForegroundNotifications(handler) {
  return messaging().onMessage(async (remoteMessage) => {
    handler?.(remoteMessage);
  });
}

export function subscribeToNotificationOpens(handler) {
  return messaging().onNotificationOpenedApp((remoteMessage) => {
    handler?.(remoteMessage);
  });
}

export async function getInitialNotification() {
  try {
    return await messaging().getInitialNotification();
  } catch (error) {
    console.warn('Failed to obtain initial notification', error);
    return null;
  }
}

export function cleanupNotificationListeners() {
  if (typeof tokenRefreshUnsubscribe === 'function') {
    tokenRefreshUnsubscribe();
    tokenRefreshUnsubscribe = null;
  }
}
