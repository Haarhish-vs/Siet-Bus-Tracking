import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';

const getEnv = (primary, fallback) => {
  if (primary && process.env[primary]) {
    return process.env[primary];
  }
  if (fallback && process.env[fallback]) {
    return process.env[fallback];
  }
  return undefined;
};

const CLOUDINARY_CLOUD_NAME = getEnv('EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_CLOUD_NAME');
const CLOUDINARY_API_KEY = getEnv('EXPO_PUBLIC_CLOUDINARY_API_KEY', 'CLOUDINARY_API_KEY');
const CLOUDINARY_API_SECRET = getEnv('EXPO_PUBLIC_CLOUDINARY_API_SECRET', 'CLOUDINARY_API_SECRET');
export const CLOUDINARY_BASE_FOLDER = (
  getEnv('EXPO_PUBLIC_CLOUDINARY_UPLOAD_FOLDER', 'CLOUDINARY_UPLOAD_FOLDER') || 'siet-bus/profiles'
).replace(/\/+$/u, '');

const DEFAULT_FOLDER = CLOUDINARY_BASE_FOLDER;

const ensureConfig = () => {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    console.error('[Cloudinary] Missing configuration', {
      hasCloudName: Boolean(CLOUDINARY_CLOUD_NAME),
      hasApiKey: Boolean(CLOUDINARY_API_KEY),
      hasApiSecret: Boolean(CLOUDINARY_API_SECRET),
    });
    throw new Error('Cloudinary environment variables are not configured.');
  }
};

const buildSignatureString = (params) => {
  const sortedKeys = Object.keys(params).sort();
  const joined = sortedKeys
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  return `${joined}${CLOUDINARY_API_SECRET}`;
};

const sanitizePublicId = (value) => {
  if (!value) return undefined;
  const sanitized = value
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\-_]+/g, '-');
  return sanitized || undefined;
};

const guessFileName = (uri) => {
  const fallback = `profile_${Date.now()}.jpg`;
  if (!uri) return fallback;
  const segments = uri.split('/');
  const lastSegment = segments.pop();
  if (!lastSegment) return fallback;
  if (lastSegment.includes('?')) {
    return lastSegment.split('?')[0];
  }
  return lastSegment;
};

const guessMimeType = (fileName = '') => {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.heic')) return 'image/heic';
  if (lower.endsWith('.jpeg')) return 'image/jpeg';
  return 'image/jpg';
};

export const uploadImageToCloudinary = async (uri, options = {}) => {
  if (!uri) {
    throw new Error('No image selected');
  }

  console.info('[Cloudinary] Image selected', { uri });
  ensureConfig();

  const baseFolder = options.folder || DEFAULT_FOLDER;
  const folder = baseFolder ? baseFolder.replace(/\/+/u, '') : undefined;
  const publicId = sanitizePublicId(options.publicId);
  const timestamp = Math.floor(Date.now() / 1000);

  console.info('[Cloudinary] Preparing upload', {
    uploadUrl: `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
    cloudName: CLOUDINARY_CLOUD_NAME,
    folder,
    publicId,
  });

  const signatureParams = {
    timestamp,
  };

  if (folder) {
    signatureParams.folder = folder;
  }

  if (publicId) {
    signatureParams.public_id = publicId;
  }

  const signatureBase = buildSignatureString(signatureParams);
  const signature = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA1, signatureBase);

  const uploadUrl = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;

  const fileName = guessFileName(uri);
  const mimeType = guessMimeType(fileName);

  const formData = new FormData();

  formData.append('file', {
    uri: Platform.OS === 'ios' ? uri.replace('file://', '') : uri,
    type: mimeType,
    name: fileName,
  });

  formData.append('api_key', CLOUDINARY_API_KEY);
  formData.append('timestamp', String(timestamp));
  formData.append('signature', signature);

  if (folder) {
    formData.append('folder', folder);
  }

  if (publicId) {
    formData.append('public_id', publicId);
  }

  console.info('[Cloudinary] Sending upload request');

  let response;
  try {
    response = await fetch(uploadUrl, {
      method: 'POST',
      body: formData,
    });
  } catch (networkError) {
    console.error('[Cloudinary] Network error while uploading', networkError);
    throw new Error('Unable to reach Cloudinary. Check network/HTTPS configuration.');
  }

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[Cloudinary] Upload failed', {
      status: response.status,
      body: errorText,
    });
    throw new Error(`Cloudinary upload failed (${response.status}): ${errorText}`);
  }

  const payload = await response.json();
  console.info('[Cloudinary] Upload success payload received', {
    hasSecureUrl: Boolean(payload?.secure_url),
    publicId: payload?.public_id,
  });

  if (!payload?.secure_url) {
    console.error('[Cloudinary] Missing secure_url in response', payload);
    throw new Error('Cloudinary response missing secure_url. Check preset / upload signature.');
  }

  return {
    secureUrl: payload.secure_url,
    publicId: payload.public_id,
    raw: payload,
  };
};
