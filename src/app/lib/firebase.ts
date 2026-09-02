import { getApp, getApps, initializeApp } from "firebase/app";
import { getAnalytics, isSupported, type Analytics } from "firebase/analytics";
import { getDatabase, onValue, ref } from "firebase/database";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "AIzaSyApFSD8Ig5vrrRQ6edttVp5kguP5PLbFhY",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "mawio-67c3b.firebaseapp.com",
  databaseURL:
    process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL ??
    "https://mawio-67c3b-default-rtdb.firebaseio.com",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "mawio-67c3b",
  storageBucket:
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? "mawio-67c3b.firebasestorage.app",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? "",
};

const measurementId =
  process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID ?? "";

export const firebaseApp = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const firebaseDatabase = getDatabase(firebaseApp);

export function ensureFirebaseAuthReady() {
  // database.rules.json currently grants the app direct database access.
  // Do not initialize Firebase Auth: Anonymous Authentication is disabled in
  // this project, and a Vercel environment override must not be able to turn
  // the broken sign-up request back on.
  return Promise.resolve();
}

// Enable offline persistence: an active onValue listener on the storage root
// ensures the SDK eagerly caches all data locally. Writes made while offline
// are automatically queued by the Firebase SDK and replayed when the
// connection is restored.
if (typeof window !== "undefined") {
  void ensureFirebaseAuthReady()
    .then(() => {
      onValue(ref(firebaseDatabase, "mawio"), () => {}, { onlyOnce: false });
    })
    .catch((error) => {
      console.error("Firebase authentication bootstrap failed", error);
    });
}

let analyticsPromise: Promise<Analytics | null> | null = null;

export function getFirebaseAnalytics() {
  if (typeof window === "undefined" || !measurementId) {
    return Promise.resolve<Analytics | null>(null);
  }

  if (!analyticsPromise) {
    analyticsPromise = isSupported()
      .then((supported) => (supported ? getAnalytics(firebaseApp) : null))
      .catch(() => null);
  }

  return analyticsPromise;
}

export { firebaseConfig, measurementId };
