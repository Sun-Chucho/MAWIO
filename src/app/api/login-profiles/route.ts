import { NextRequest, NextResponse } from "next/server";
import { readServerSyncedStorageValue, writeServerSyncedStorageValue } from "@/app/lib/firebase-server";
import { STORAGE_LOGIN_PROFILES, type LoginProfiles, type LoginProfileEntry, type LoginUserAccount } from "@/app/lib/login-profiles";
import { normalizeRole } from "@/app/lib/auth";

export const runtime = "nodejs";
const LEGACY_STANDARD_LOGIN_PROFILES = "orange-hotel-login-profiles-standard";

async function readConsolidatedProfiles() {
  const [profiles, legacyProfiles] = await Promise.all([
    readServerSyncedStorageValue<LoginProfiles>(STORAGE_LOGIN_PROFILES),
    readServerSyncedStorageValue<LoginProfiles>(LEGACY_STANDARD_LOGIN_PROFILES),
  ]);
  const consolidated = { ...(legacyProfiles ?? {}), ...(profiles ?? {}) };
  if (legacyProfiles && JSON.stringify(consolidated) !== JSON.stringify(profiles ?? {})) {
    await writeServerSyncedStorageValue(STORAGE_LOGIN_PROFILES, consolidated);
  }
  return consolidated;
}

function sanitizeEntry(entry: Partial<LoginProfileEntry> | null | undefined): LoginProfileEntry | null {
  const username = typeof entry?.username === "string" ? entry.username.trim() : "";
  if (!username) return null;

  const shift = entry?.shift === "day" || entry?.shift === "night" ? entry.shift : undefined;
  const updatedAt = typeof entry?.updatedAt === "number" && Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now();
  const password = typeof entry?.password === "string" && entry.password.trim() ? entry.password.trim() : undefined;
  const users = Array.isArray(entry?.users)
    ? entry.users
        .map((user) => {
          const userName = typeof user?.username === "string" ? user.username.trim() : "";
          if (!userName) return null;
          const userPassword = typeof user?.password === "string" && user.password.trim() ? user.password.trim() : undefined;
          const userUpdatedAt = typeof user?.updatedAt === "number" && Number.isFinite(user.updatedAt) ? user.updatedAt : updatedAt;
          const nextUser: LoginUserAccount = {
            username: userName,
            ...(userPassword ? { password: userPassword } : {}),
            ...(user?.blocked === true ? { blocked: true } : {}),
            updatedAt: userUpdatedAt,
          };
          return nextUser;
        })
        .filter(Boolean) as LoginUserAccount[]
    : undefined;

  return {
    username,
    ...(password ? { password } : {}),
    ...(shift ? { shift } : {}),
    ...(users && users.length > 0 ? { users } : {}),
    updatedAt,
  };
}

export async function GET(request: NextRequest) {
  void request;
  try {
    const profiles = await readConsolidatedProfiles();
    return NextResponse.json(profiles);
  } catch {
    return NextResponse.json({});
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { scope?: string; role?: string; entry?: Partial<LoginProfileEntry> };
    const role = normalizeRole(body?.role);
    const entry = sanitizeEntry(body?.entry);

    if (!role || !entry) {
      return NextResponse.json({ error: "Invalid login profile payload." }, { status: 400 });
    }

    const current = await readConsolidatedProfiles();
    const next: LoginProfiles = {
      ...current,
      [role]: entry,
    };

    await writeServerSyncedStorageValue(STORAGE_LOGIN_PROFILES, next);
    return NextResponse.json(next);
  } catch {
    return NextResponse.json({ error: "Unable to save login profile." }, { status: 500 });
  }
}
