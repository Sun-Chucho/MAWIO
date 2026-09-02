const FIREBASE_API_KEY =
  process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "AIzaSyApFSD8Ig5vrrRQ6edttVp5kguP5PLbFhY";
const FIREBASE_DATABASE_URL =
  process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL ??
  "https://mawio-67c3b-default-rtdb.firebaseio.com/";
const FIREBASE_STORAGE_ROOT = "mawio";
const FIREBASE_ANONYMOUS_AUTH_ENABLED =
  process.env.FIREBASE_ANONYMOUS_AUTH_ENABLED === "true";

type FirebaseAnonSession = {
  idToken: string;
  expiresAt: number;
};

let anonSessionPromise: Promise<FirebaseAnonSession> | null = null;

function getDatabaseBaseUrl() {
  return FIREBASE_DATABASE_URL.replace(/\/+$/, "");
}

function toStoragePath(key: string) {
  return `${FIREBASE_STORAGE_ROOT}/standard/current/${key.replace(/[.#$[\]/]/g, "-")}`;
}

async function getAnonymousSession() {
  if (!anonSessionPromise) {
    anonSessionPromise = fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(FIREBASE_API_KEY)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnSecureToken: true }),
        cache: "no-store",
      },
    )
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Anonymous Firebase auth failed (${response.status})`);
        }

        const payload = (await response.json()) as { idToken?: string; expiresIn?: string };
        if (!payload.idToken) {
          throw new Error("Anonymous Firebase auth did not return an ID token.");
        }

        const expiresInMs = Math.max(60, Number(payload.expiresIn ?? "3600")) * 1000;
        return {
          idToken: payload.idToken,
          expiresAt: Date.now() + expiresInMs - 60000,
        };
      })
      .catch((error) => {
        anonSessionPromise = null;
        throw error;
      });
  }

  const session = await anonSessionPromise;
  if (Date.now() >= session.expiresAt) {
    anonSessionPromise = null;
    return getAnonymousSession();
  }

  return session;
}

async function requestDatabasePath(path: string, init?: RequestInit, allowedStatuses: number[] = []) {
  const basePath = `${getDatabaseBaseUrl()}/${path}.json`;

  const runRequest = async (idToken?: string) => {
    const path = idToken ? `${basePath}?auth=${encodeURIComponent(idToken)}` : basePath;
    return fetch(path, {
      ...init,
      cache: "no-store",
    });
  };

  let response: Response;
  if (!FIREBASE_ANONYMOUS_AUTH_ENABLED) {
    response = await runRequest();
  } else {
    try {
      const { idToken } = await getAnonymousSession();
      response = await runRequest(idToken);
    } catch {
      response = await runRequest();
    }
  }

  if ((response.status === 401 || response.status === 403) && !response.ok) {
    response = await runRequest();
  }

  if (!response.ok && !allowedStatuses.includes(response.status)) {
    throw new Error(`Realtime Database request failed (${response.status})`);
  }

  return response;
}

async function requestDatabase(key: string, init?: RequestInit, allowedStatuses: number[] = []) {
  return requestDatabasePath(toStoragePath(key), init, allowedStatuses);
}

export async function readServerSyncedStorageValue<T>(key: string) {
  const response = await requestDatabase(key, { method: "GET" });
  return (await response.json()) as T | null;
}

export async function writeServerSyncedStorageValue<T>(key: string, value: T) {
  await requestDatabase(key, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}

/**
 * Atomically update a Realtime Database value through the REST fallback.
 * Firebase REST ETags make the read/merge/write conditional; if another POS
 * wins the race, we re-read its value and merge again instead of overwriting it.
 */
export async function updateServerSyncedStorageValue<T>(
  key: string,
  updateValue: (currentValue: T | null) => T,
) {
  const maxAttempts = 8;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const readResponse = await requestDatabase(key, {
      method: "GET",
      headers: { "X-Firebase-ETag": "true" },
    });
    const etag = readResponse.headers.get("ETag");
    if (!etag) {
      throw new Error("Realtime Database did not return an ETag for an atomic update");
    }

    const currentValue = (await readResponse.json()) as T | null;
    const nextValue = updateValue(currentValue);
    const writeResponse = await requestDatabase(
      key,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "If-Match": etag,
        },
        body: JSON.stringify(nextValue),
      },
      [412],
    );

    if (writeResponse.status !== 412) return nextValue;
  }

  throw new Error("Realtime Database atomic update exceeded its retry limit");
}

/** Atomically update the complete Standard storage root. This is reserved for
 * operations whose invariants span more than one storage key, such as a
 * Barista checkout plus both stock ledgers. */
export async function updateServerSyncedStorageRoot<T>(
  updateValue: (currentValue: T | null) => T,
) {
  const maxAttempts = 8;
  const rootPath = `${FIREBASE_STORAGE_ROOT}/standard/current`;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const readResponse = await requestDatabasePath(rootPath, {
      method: "GET",
      headers: { "X-Firebase-ETag": "true" },
    });
    const etag = readResponse.headers.get("ETag");
    if (!etag) {
      throw new Error("Realtime Database did not return an ETag for an atomic root update");
    }

    const currentValue = (await readResponse.json()) as T | null;
    const nextValue = updateValue(currentValue);
    const writeResponse = await requestDatabasePath(
      rootPath,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "If-Match": etag,
        },
        body: JSON.stringify(nextValue),
      },
      [412],
    );
    if (writeResponse.status !== 412) return nextValue;
  }

  throw new Error("Realtime Database atomic root update exceeded its retry limit");
}

export async function appendServerSyncedStorageItem<T>(key: string, item: T) {
  const current = await readServerSyncedStorageValue<T[]>(key);
  const next = Array.isArray(current) ? [item, ...current] : [item];
  await writeServerSyncedStorageValue(key, next);
}
