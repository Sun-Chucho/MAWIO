import { getApp, getApps, initializeApp } from "firebase/app";
import { getAnalytics, isSupported, type Analytics } from "firebase/analytics";
import { browserLocalPersistence, getAuth, onAuthStateChanged, setPersistence, signInAnonymously } from "firebase/auth";
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

const anonymousAuthEnabled =
  process.env.NEXT_PUBLIC_FIREBASE_ANONYMOUS_AUTH_ENABLED === "true";

export const firebaseApp = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const firebaseAuth = getAuth(firebaseApp);
export const firebaseDatabase = getDatabase(firebaseApp);

let authReadyPromise: Promise<void> | null = null;
const AUTH_READY_TIMEOUT_MS = 2500;

export function ensureFirebaseAuthReady() {
  if (typeof window === "undefined") {
    return Promise.resolve();
  }

  if (!authReadyPromise) {
    authReadyPromise = (async () => {
      try {
        await setPersistence(firebaseAuth, browserLocalPersistence);
      } catch {
        // Fall back to the default auth persistence if the environment blocks local persistence.
      }

      if (firebaseAuth.currentUser) {
        return;
      }

      // This deployment uses the public Realtime Database rules in
      // database.rules.json. Anonymous Authentication is not configured in
      // the Firebase project, so attempting signInAnonymously only produces
      // auth/configuration-not-found and delays every sync operation.
      if (!anonymousAuthEnabled) {
        return;
      }

      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };

        const timeoutId = window.setTimeout(() => {
          console.warn("Firebase auth bootstrap timed out, continuing without client auth.");
          unsubscribe();
          finish();
        }, AUTH_READY_TIMEOUT_MS);

        const unsubscribe = onAuthStateChanged(
          firebaseAuth,
          (user) => {
            if (!user) return;
            window.clearTimeout(timeoutId);
            unsubscribe();
            finish();
          },
          () => {
            window.clearTimeout(timeoutId);
            unsubscribe();
            finish();
          },
        );

        signInAnonymously(firebaseAuth).catch((error) => {
          window.clearTimeout(timeoutId);
          console.warn("Firebase anonymous auth unavailable, continuing without client auth.", error);
          unsubscribe();
          finish();
        });
      });
    })().catch((error) => {
      authReadyPromise = null;
      throw error;
    });
  }

  return authReadyPromise;
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
