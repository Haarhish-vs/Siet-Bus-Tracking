require('dotenv').config();
const { withAndroidManifest } = require('@expo/config-plugins');

const ANDROID_MAPS_API_KEY = process.env.EXPO_PUBLIC_ANDROID_MAPS_API_KEY || 'AIzaSyCPz7I0tCRtmXUn5FZRVXjdi03oc-ye1rw';

// Inject Google Maps API key into AndroidManifest at build time
const withGoogleMapsMeta = (config) =>
  withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    manifest.$ = manifest.$ || {};
    if (!manifest.$['xmlns:tools']) {
      manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    }

    const application = manifest.application?.[0];
    if (!application) {
      return config;
    }

    application['meta-data'] = application['meta-data'] || [];
    application['meta-data'] = application['meta-data'].filter(
      (entry) => entry.$['android:name'] !== 'com.google.android.geo.API_KEY'
    );
    application['meta-data'].push({
      $: {
        'android:name': 'com.google.android.geo.API_KEY',
        'android:value': ANDROID_MAPS_API_KEY,
      },
    });

    return config;
  });

// Keep FCM notification color meta in sync
const withSingleFcmColorMeta = (config) =>
  withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    manifest.$ = manifest.$ || {};
    if (!manifest.$['xmlns:tools']) {
      manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    }

    const application = manifest.application?.[0];
    if (!application) {
      return config;
    }

    const existingMeta = application['meta-data'] || [];
    application['meta-data'] = existingMeta.filter(
      (entry) => entry.$['android:name'] !== 'com.google.firebase.messaging.default_notification_color'
    );

    application['meta-data'].push({
      $: {
        'android:name': 'com.google.firebase.messaging.default_notification_color',
        'android:resource': '@color/notification_icon_color',
        'tools:replace': 'android:resource',
      },
    });

    return config;
  });

const baseExpoConfig = {
  name: 'sietbusapp',
  slug: 'sietbusapp',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'light',
  splash: {
    image: './assets/splash-icon.png',
    resizeMode: 'contain',
    backgroundColor: '#ffffff',
  },
  // Ensure this stays in sync with google-services.json (Android) and Firebase project settings
  // Changing android.package requires downloading a new google-services.json for that package
  ios: {
    supportsTablet: true,
    infoPlist: {
      UIBackgroundModes: ['location'],
      NSLocationWhenInUseUsageDescription:
        'Allow SIET Bus Tracking to access your location while you use the app to show real-time journeys.',
      NSLocationAlwaysAndWhenInUseUsageDescription:
        'Allow SIET Bus Tracking to access your location even when the app is closed so that students can see live bus updates.',
      NSLocationAlwaysUsageDescription:
        'Allow SIET Bus Tracking to continue sharing your bus location when the app is in the background.',
      NSLocationUsageDescription:
        'Allow SIET Bus Tracking to access your location for live bus tracking.',
      ITSAppUsesNonExemptEncryption: false,
    },
    bundleIdentifier: 'com.haarhish.sietbusapp',
  },
  android: {
    googleServicesFile: './google-services.json',
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#ffffff',
    },
    edgeToEdgeEnabled: true,
    googleMaps: {
      apiKey: ANDROID_MAPS_API_KEY,
    },
    permissions: [
      'POST_NOTIFICATIONS',
      'ACCESS_COARSE_LOCATION',
      'ACCESS_FINE_LOCATION',
      'ACCESS_BACKGROUND_LOCATION',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_LOCATION',
    ],
    // Keep this exactly in sync with google-services.json -> client[0].client_info.android_client_info.package_name
    package: 'siet.com',
  },
  notification: {
    icon: './assets/notification-icon.png',
    color: '#1D4ED8',
    androidMode: 'default',
  },
  web: {
    favicon: './assets/favicon.png',
  },
  plugins: [
    [
      'expo-location',
      {
        locationAlwaysAndWhenInUsePermission:
          'Allow SIET Bus Tracking to access your location even when the app is closed so that students can see live bus updates.',
        locationWhenInUsePermission:
          'Allow SIET Bus Tracking to access your location while you use the app.',
        isIosBackgroundLocationEnabled: true,
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
        androidForegroundServiceNotificationTitle: 'SIET Bus Tracking',
        androidForegroundServiceNotificationBody: 'Location tracking is active.',
      },
    ],
    'expo-mail-composer',
    'expo-font',
  ],
  extra: {
    firebase: {
      apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
    },
    backend: {
      baseUrl: process.env.EXPO_PUBLIC_NOTIFICATION_SERVER_URL,
    },
    cloudinary: {
      cloudName: process.env.EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.EXPO_PUBLIC_CLOUDINARY_API_KEY,
      uploadFolder: process.env.EXPO_PUBLIC_CLOUDINARY_UPLOAD_FOLDER,
    },
    eas: {
      projectId: '7ccd10d2-9d0a-439a-8816-260ef2b9d6b6',
    },
  },
  owner: 'haarhish23',
};

module.exports = () => ({
  expo: {
    ...baseExpoConfig,
    plugins: [...baseExpoConfig.plugins, withSingleFcmColorMeta, withGoogleMapsMeta],
  },
});
