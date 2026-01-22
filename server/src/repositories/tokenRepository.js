const { db, admin } = require('../config/firebaseAdmin');

const USERS_COLLECTION = 'users';
const TARGET_ROLES = ['student', 'coadmin', 'incharge'];

async function getRecipientsByBus(busNumber) {
  if (!busNumber) {
    return [];
  }

  const snapshot = await db.collection(USERS_COLLECTION).where('busNumber', '==', busNumber).get();

  if (snapshot.empty) {
    return [];
  }

  return snapshot.docs
    .map((document) => {
      const data = document.data();
      const role = (data.role || '').toLowerCase();
      if (!TARGET_ROLES.includes(role)) {
        return null;
      }
      const tokens = Array.isArray(data.fcmTokens) ? data.fcmTokens.filter(Boolean) : [];
      return {
        uid: document.id,
        role,
        busNumber: data.busNumber,
        tokens,
      };
    })
    .filter(Boolean);
}

async function getRecipientsByRole(role) {
  if (!role) {
    return [];
  }

  const normalizedRole = role.toLowerCase();
  const snapshot = await db.collection(USERS_COLLECTION).where('role', '==', normalizedRole).get();

  if (snapshot.empty) {
    return [];
  }

  return snapshot.docs.map((document) => {
    const data = document.data();
    const tokens = Array.isArray(data.fcmTokens) ? data.fcmTokens.filter(Boolean) : [];
    return {
      uid: document.id,
      role: normalizedRole,
      tokens,
    };
  });
}

async function getTokensForUser(uid) {
  if (!uid) {
    return [];
  }

  const docRef = db.collection(USERS_COLLECTION).doc(uid);
  const snap = await docRef.get();
  if (!snap.exists) {
    return [];
  }

  const data = snap.data();
  return Array.isArray(data.fcmTokens) ? data.fcmTokens.filter(Boolean) : [];
}

async function removeTokens(uid, tokens = []) {
  if (!uid || !tokens.length) {
    return;
  }

  const docRef = db.collection(USERS_COLLECTION).doc(uid);
  try {
    await docRef.update({
      fcmTokens: admin.firestore.FieldValue.arrayRemove(...tokens),
    });
  } catch (error) {
    console.warn(`Unable to remove invalid tokens for user ${uid}`, error);
  }
}

module.exports = {
  getRecipientsByBus,
  getTokensForUser,
  getRecipientsByRole,
  removeTokens,
};
