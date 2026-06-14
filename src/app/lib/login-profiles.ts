"use client";

import { Role } from "@/app/lib/mock-data";
import { readJson, writeJson } from "@/app/lib/storage";

export const STORAGE_LOGIN_PROFILES = "orange-hotel-login-profiles";
export const STORAGE_ACTIVE_USERNAME = "orange-hotel-username";
export const SESSION_IDENTITY_EVENT = "orange-hotel-session-identity-updated";
export type LoginProfileScope = "core" | "standard" | "platinum";

export function getLocalMawioTier(): "standard" | "platinum" {
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    const queryTier = params.get("tier");
    if (queryTier === "standard" || queryTier === "platinum") {
      window.localStorage.setItem("orange-hotel-active-login-scope", queryTier);
      return queryTier;
    }
    const activeScope = window.localStorage.getItem("orange-hotel-active-login-scope");
    if (activeScope === "standard" || activeScope === "platinum") return activeScope;
    const localTier = window.localStorage.getItem("mawio-tier");
    if (localTier === "standard" || localTier === "platinum") {
      window.localStorage.setItem("orange-hotel-active-login-scope", localTier);
      return localTier;
    }
  }
  return "standard";
}

export interface LoginUserAccount {
  username: string;
  password?: string;
  blocked?: boolean;
  updatedAt: number;
}

export interface LoginProfileEntry {
  username: string;
  password?: string;
  shift?: "day" | "night";
  users?: LoginUserAccount[];
  updatedAt: number;
}

export type LoginProfiles = Partial<Record<Role, LoginProfileEntry>>;

export const DEFAULT_LOGIN_PASSWORD = "1234";
export const MANAGER_LOGIN_PASSWORD = "4321";
export const MANAGER_SESSION_VERSION = "manager-password-4321-v1";
export const STORAGE_MANAGER_SESSION_VERSION = "orange-hotel-manager-session-version";

const STORAGE_LOGIN_PROFILES_BY_SCOPE: Record<LoginProfileScope, string> = {
  core: STORAGE_LOGIN_PROFILES,
  standard: "orange-hotel-login-profiles-standard",
  platinum: "orange-hotel-login-profiles-platinum",
};

const STORAGE_ACTIVE_USERNAME_BY_SCOPE: Record<LoginProfileScope, string> = {
  core: STORAGE_ACTIVE_USERNAME,
  standard: "orange-hotel-username-standard",
  platinum: "orange-hotel-username-platinum",
};

const STORAGE_ACTIVE_ROLE_BY_SCOPE: Record<LoginProfileScope, string> = {
  core: "orange-hotel-role",
  standard: "orange-hotel-role-standard",
  platinum: "orange-hotel-role-platinum",
};

const STORAGE_MANAGER_SESSION_VERSION_BY_SCOPE: Record<LoginProfileScope, string> = {
  core: STORAGE_MANAGER_SESSION_VERSION,
  standard: "orange-hotel-manager-session-version-standard",
  platinum: "orange-hotel-manager-session-version-platinum",
};

export function normalizeLoginProfileScope(value: string | null | undefined): LoginProfileScope {
  return value === "platinum" ? "platinum" : value === "standard" ? "standard" : "core";
}

export function getLoginProfilesStorageKey(scope: LoginProfileScope = "core") {
  return STORAGE_LOGIN_PROFILES_BY_SCOPE[scope];
}

export function getActiveSessionUsernameStorageKey(scope: LoginProfileScope = "core") {
  return STORAGE_ACTIVE_USERNAME_BY_SCOPE[scope];
}

export function getActiveSessionRoleStorageKey(scope: LoginProfileScope = "core") {
  return STORAGE_ACTIVE_ROLE_BY_SCOPE[scope];
}

export function getManagerSessionVersionStorageKey(scope: LoginProfileScope = "core") {
  return STORAGE_MANAGER_SESSION_VERSION_BY_SCOPE[scope];
}

export function getDefaultLoginPassword(role: Role) {
  return role === "manager" ? MANAGER_LOGIN_PASSWORD : DEFAULT_LOGIN_PASSWORD;
}

function dispatchLoginProfilesUpdated(scope: LoginProfileScope) {
  window.dispatchEvent(new CustomEvent("orange-hotel-storage-updated", { detail: { key: getLoginProfilesStorageKey(scope) } }));
}

function dispatchSessionIdentityUpdated() {
  window.dispatchEvent(new CustomEvent(SESSION_IDENTITY_EVENT));
}

export function readLocalLoginProfiles(scope?: LoginProfileScope) {
  if (typeof window === "undefined") return null;
  const activeScope = scope ?? getLocalMawioTier();
  return readJson<LoginProfiles>(getLoginProfilesStorageKey(activeScope));
}

export function writeLocalLoginProfiles(profiles: LoginProfiles, scope?: LoginProfileScope) {
  if (typeof window === "undefined") return;
  const activeScope = scope ?? getLocalMawioTier();
  writeJson(getLoginProfilesStorageKey(activeScope), profiles);
  dispatchLoginProfilesUpdated(activeScope);
}

export function readActiveSessionUsername(fallback = "", scope?: LoginProfileScope) {
  if (typeof window === "undefined") return fallback;
  const activeScope = scope ?? getLocalMawioTier();
  return localStorage.getItem(getActiveSessionUsernameStorageKey(activeScope)) ?? fallback;
}

export function writeActiveSessionUsername(username: string, scope?: LoginProfileScope) {
  if (typeof window === "undefined") return;
  const activeScope = scope ?? getLocalMawioTier();
  localStorage.setItem(getActiveSessionUsernameStorageKey(activeScope), username.trim());
  dispatchSessionIdentityUpdated();
}

export function subscribeToSessionIdentity(onChange: () => void) {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const handleCustomEvent = () => onChange();
  const handleStorageEvent = (event: StorageEvent) => {
    if (event.key === STORAGE_ACTIVE_USERNAME) {
      onChange();
    }
  };

  window.addEventListener(SESSION_IDENTITY_EVENT, handleCustomEvent);
  window.addEventListener("storage", handleStorageEvent);

  return () => {
    window.removeEventListener(SESSION_IDENTITY_EVENT, handleCustomEvent);
    window.removeEventListener("storage", handleStorageEvent);
  };
}

export async function hydrateLoginProfilesFromServer(scope?: LoginProfileScope) {
  if (typeof window === "undefined") return null;
  const activeScope = scope ?? getLocalMawioTier();

  try {
    const params = new URLSearchParams();
    if (activeScope !== "core") {
      params.set("scope", activeScope);
    }
    const response = await fetch(`/api/login-profiles${params.toString() ? `?${params.toString()}` : ""}`, { cache: "no-store" });
    if (!response.ok) return null;
    const profiles = (await response.json()) as LoginProfiles;
    writeLocalLoginProfiles(profiles ?? {}, activeScope);
    return profiles ?? {};
  } catch {
    return null;
  }
}

export function saveLoginProfileToServer(role: Role, entry: LoginProfileEntry): Promise<boolean>;
export function saveLoginProfileToServer(scope: LoginProfileScope, role: Role, entry: LoginProfileEntry): Promise<boolean>;
export async function saveLoginProfileToServer(
  scopeOrRole: LoginProfileScope | Role,
  roleOrEntry: Role | LoginProfileEntry,
  scopedEntry?: LoginProfileEntry,
) {
  if (typeof window === "undefined") return false;

  const scope: LoginProfileScope = scopedEntry ? (scopeOrRole as LoginProfileScope) : getLocalMawioTier();
  const role = scopedEntry ? (roleOrEntry as Role) : (scopeOrRole as Role);
  const entry = scopedEntry ?? (roleOrEntry as LoginProfileEntry);

  try {
    const response = await fetch("/api/login-profiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ scope, role, entry }),
    });

    if (!response.ok) return false;
    const profiles = (await response.json()) as LoginProfiles;
    writeLocalLoginProfiles(profiles ?? {}, scope);
    return true;
  } catch {
    return false;
  }
}

export function getProfilePassword(entry: LoginProfileEntry | null | undefined, username: string, fallback = DEFAULT_LOGIN_PASSWORD) {
  if (!entry) return fallback;

  const matchedUser = entry.users?.find((user) => user.username.trim().toLowerCase() === username.trim().toLowerCase());
  if (matchedUser?.password?.trim()) return matchedUser.password.trim();
  if (entry.password?.trim()) return entry.password.trim();
  return fallback;
}

export function isProfileUserBlocked(entry: LoginProfileEntry | null | undefined, username: string) {
  const matchedUser = entry?.users?.find((user) => user.username.trim().toLowerCase() === username.trim().toLowerCase());
  return matchedUser?.blocked === true;
}

export function upsertProfileUser(
  entry: LoginProfileEntry | null | undefined,
  username: string,
  updates: Partial<LoginUserAccount>,
): LoginProfileEntry {
  const normalizedUsername = username.trim();
  const now = typeof updates.updatedAt === "number" && Number.isFinite(updates.updatedAt) ? updates.updatedAt : Date.now();
  const existingUsers = Array.isArray(entry?.users) ? entry.users : [];
  const nextUser: LoginUserAccount = {
    username: normalizedUsername,
    password: typeof updates.password === "string" ? updates.password.trim() : existingUsers.find((user) => user.username.toLowerCase() === normalizedUsername.toLowerCase())?.password,
    blocked: typeof updates.blocked === "boolean" ? updates.blocked : existingUsers.find((user) => user.username.toLowerCase() === normalizedUsername.toLowerCase())?.blocked,
    updatedAt: now,
  };

  const otherUsers = existingUsers.filter((user) => user.username.toLowerCase() !== normalizedUsername.toLowerCase());

  return {
    username: normalizedUsername,
    password: typeof updates.password === "string" ? updates.password.trim() : entry?.password,
    shift: entry?.shift,
    users: [...otherUsers, nextUser],
    updatedAt: now,
  };
}

export function renameProfileUser(
  entry: LoginProfileEntry | null | undefined,
  previousUsername: string,
  nextUsername: string,
): LoginProfileEntry {
  const normalizedPrevious = previousUsername.trim().toLowerCase();
  const normalizedNext = nextUsername.trim();
  const now = Date.now();
  const existingUsers = Array.isArray(entry?.users) ? entry.users : [];
  const previousUser = existingUsers.find((user) => user.username.trim().toLowerCase() === normalizedPrevious);
  const nextUser = existingUsers.find((user) => user.username.trim().toLowerCase() === normalizedNext.toLowerCase());
  const filteredUsers = existingUsers.filter((user) => {
    const normalizedUser = user.username.trim().toLowerCase();
    return normalizedUser !== normalizedPrevious && normalizedUser !== normalizedNext.toLowerCase();
  });

  return {
    username: normalizedNext,
    password: entry?.password,
    shift: entry?.shift,
    users: [
      ...filteredUsers,
      {
        username: normalizedNext,
        password: previousUser?.password ?? nextUser?.password ?? entry?.password,
        updatedAt: now,
      },
    ],
    updatedAt: now,
  };
}
