const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const SERVICE_ACCOUNT_PATH_ENV = 'FIREBASE_SERVICE_ACCOUNT_PATH';
const SERVICE_ACCOUNT_JSON_ENV = 'FIREBASE_ADMIN_KEY';

function loadServiceAccountFromEnv() {
  const inlineCredentials = process.env[SERVICE_ACCOUNT_JSON_ENV];
  if (!inlineCredentials) {
    return null;
  }

  try {
    return JSON.parse(inlineCredentials);
  } catch (error) {
    throw new Error(
      `Unable to parse ${SERVICE_ACCOUNT_JSON_ENV} JSON from environment: ${error.message}`
    );
  }
}

function resolveServiceAccountPath() {
  const customPath = process.env[SERVICE_ACCOUNT_PATH_ENV];
  if (customPath) {
    const absolute = path.resolve(customPath);
    if (!fs.existsSync(absolute)) {
      throw new Error(`Service account file not found at ${absolute}.`);
    }
    return absolute;
  }

  const fallbackCandidates = [
    path.resolve(__dirname, '..', '..', 'serviceAccountKey.json'),
    path.resolve(__dirname, '..', '..', '..', 'serviceAccountKey.json'),
  ];

  for (const candidate of fallbackCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `serviceAccountKey.json missing. Set ${SERVICE_ACCOUNT_PATH_ENV} or place the file in either the project root or server directory.`
  );
}

function loadServiceAccount() {
  const inlineCredentials = loadServiceAccountFromEnv();
  if (inlineCredentials) {
    return inlineCredentials;
  }

  const filePath = resolveServiceAccountPath();
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Unable to parse service account JSON at ${filePath}: ${error.message}`);
  }
}

function initializeAdmin() {
  if (admin.apps.length > 0) {
    return admin;
  }

  const credentials = loadServiceAccount();
  admin.initializeApp({
    credential: admin.credential.cert(credentials),
    projectId: credentials.project_id,
  });

  return admin;
}

const firebaseAdmin = initializeAdmin();
const firestore = firebaseAdmin.firestore();

module.exports = {
  admin: firebaseAdmin,
  db: firestore,
};
