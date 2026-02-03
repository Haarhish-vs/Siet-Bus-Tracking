import { Platform } from 'react-native';
import Constants from 'expo-constants';

const DEFAULT_ANDROID = 'http://10.0.2.2:4000';
const DEFAULT_IOS = 'http://127.0.0.1:4000';

const sanitizeBaseUrl = (value) => {
  if (!value || typeof value !== 'string') {
    return null;
  }
  return value.trim().replace(/\/$/, '');
};

const inferExpoHostUrl = () => {
  const expoConfig = Constants.expoConfig || {};
  const manifest = Constants.manifest || {};
  const manifestExtra = Constants.manifest2?.extra?.expoClient || {};

  const hostUri =
    expoConfig.hostUri ||
    manifest.debuggerHost ||
    manifest.hostUri ||
    manifestExtra.debuggerHost ||
    manifestExtra.hostUri ||
    null;

  if (!hostUri) {
    return null;
  }

  const host = hostUri.split(':')[0];
  if (!host) {
    return null;
  }

  return `http://${host}:4000`;
};

const buildCandidateBaseUrls = () => {
  const extra = Constants.expoConfig?.extra || {};
  const backendExtra = extra.backend || {};
  const envUrl = sanitizeBaseUrl(backendExtra.baseUrl || process.env.EXPO_PUBLIC_NOTIFICATION_SERVER_URL);
  const expoHostUrl = sanitizeBaseUrl(inferExpoHostUrl());
  const platformDefault = Platform.OS === 'android' ? DEFAULT_ANDROID : DEFAULT_IOS;

  return [envUrl, expoHostUrl, sanitizeBaseUrl(platformDefault)].filter(Boolean);
};

export async function postJson(path, body, options = {}) {
  if (!path.startsWith('/')) {
    throw new Error('Paths passed to backendClient must start with /');
  }

  const candidates = buildCandidateBaseUrls();
  const errors = [];

  for (const baseUrl of candidates) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
        body: JSON.stringify(body || {}),
      });

      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `HTTP ${response.status}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      errors.push({ baseUrl, message: error.message });
    }
  }

  const readable = errors.map((entry) => `${entry.baseUrl}: ${entry.message}`).join('; ');
  throw new Error(`All notification endpoints failed → ${readable}`);
}

export async function postJsonWithFallbacks(path, body, options) {
  return postJson(path, body, options);
}
