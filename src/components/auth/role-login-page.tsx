"use client";

import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Building2, Coffee, Lock, Package, ShieldCheck, ShoppingCart, Sun, Moon, User, Utensils } from "lucide-react";
import { Role } from "@/app/lib/mock-data";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  getActiveSessionRoleStorageKey,
  getActiveSessionUsernameStorageKey,
  getDefaultLoginPassword,
  getLoginProfilesStorageKey,
  getManagerSessionVersionStorageKey,
  getProfilePassword,
  hydrateLoginProfilesFromServer,
  isProfileUserBlocked,
  LoginProfiles,
  LoginProfileScope,
  MANAGER_SESSION_VERSION,
  readLocalLoginProfiles,
  saveLoginProfileToServer,
  upsertProfileUser,
  writeLocalLoginProfiles,
} from "@/app/lib/login-profiles";

interface RoleLoginPageProps {
  role: Role;
  initialHotelRole?: HotelLoginRole;
}

type LoginRole = Exclude<Role, "standard" | "platinum">;
type HotelLoginRole = Exclude<LoginRole, "director">;

type LoginConfig = {
  label: string;
  username: string;
  color: string;
  destination: string;
  icon: typeof ShieldCheck;
};

const ROLE_CONFIG: Record<Role, LoginConfig> = {
  manager: {
    label: "Hotel Manager",
    username: "manager",
    color: "bg-orange-500",
    destination: "/dashboard",
    icon: ShieldCheck,
  },
  director: {
    label: "Managing Director",
    username: "md",
    color: "bg-emerald-700",
    destination: "/dashboard",
    icon: Building2,
  },
  inventory: {
    label: "Inventory Manager",
    username: "inventory",
    color: "bg-black",
    destination: "/dashboard/inventory",
    icon: Package,
  },
  cashier: {
    label: "Reception Booking",
    username: "reception",
    color: "bg-orange-600",
    destination: "/dashboard/cashier",
    icon: ShoppingCart,
  },
  kitchen: {
    label: "Kitchen POS",
    username: "kitchen",
    color: "bg-orange-700",
    destination: "/dashboard/kitchen",
    icon: Utensils,
  },
  barista: {
    label: "Barista POS",
    username: "barista",
    color: "bg-orange-400",
    destination: "/dashboard/barista",
    icon: Coffee,
  },
  standard: {
    label: "Standard Hotel",
    username: "standard",
    color: "bg-blue-500",
    destination: "/standard",
    icon: Sun,
  },
  platinum: {
    label: "Platinum Hotel",
    username: "platinum",
    color: "bg-amber-500",
    destination: "/platinum",
    icon: Moon,
  },
};

const HOTEL_ROLE_CONFIG: Record<HotelLoginRole, LoginConfig> = {
  manager: ROLE_CONFIG.manager,
  inventory: ROLE_CONFIG.inventory,
  cashier: {
    ...ROLE_CONFIG.cashier,
    label: "Receptionist",
    username: "receptionist",
  },
  kitchen: ROLE_CONFIG.kitchen,
  barista: ROLE_CONFIG.barista,
};

const HOTEL_LOGIN_ROLES: HotelLoginRole[] = ["manager", "cashier", "inventory", "kitchen", "barista"];

const HOTEL_ROLE_PATHS: Record<HotelLoginRole, string> = {
  manager: "manager",
  cashier: "receptionist",
  inventory: "inventory",
  kitchen: "kitchen",
  barista: "barista",
};

export function RoleLoginPage({ role, initialHotelRole = "manager" }: RoleLoginPageProps) {
  const [shift, setShift] = useState<"day" | "night">("day");
  const isHotelTierPage = role === "standard" || role === "platinum";
  const loginScope: LoginProfileScope = isHotelTierPage ? role : "core";
  const [selectedRole, setSelectedRole] = useState<HotelLoginRole>(initialHotelRole);
  const activeRole: LoginRole = isHotelTierPage ? selectedRole : (role as LoginRole);
  const pageConfig = ROLE_CONFIG[role];
  const roleConfig = isHotelTierPage ? HOTEL_ROLE_CONFIG[selectedRole] : ROLE_CONFIG[activeRole];
  const isDirector = role === "director";
  const [profileUsers, setProfileUsers] = useState<Array<{ id: string; name: string; blocked?: boolean }>>([]);
  const selectableUsers = useMemo(() => {
    return profileUsers.filter((user) => !user.blocked);
  }, [profileUsers]);
  const sessionUsernameKey = getActiveSessionUsernameStorageKey(loginScope);
  const sessionRoleKey = getActiveSessionRoleStorageKey(loginScope);
  const managerSessionKey = getManagerSessionVersionStorageKey(loginScope);
  const shiftStorageKey = loginScope === "core" ? "orange-hotel-shift" : `orange-hotel-shift-${loginScope}`;
  const storedUsername = typeof window !== "undefined" ? localStorage.getItem(sessionUsernameKey) : null;
  const [username, setUsername] = useState(storedUsername ?? roleConfig.username);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const roleDefaultPassword = getDefaultLoginPassword(activeRole);

  useEffect(() => {
    const applyProfiles = () => {
      const profiles = readLocalLoginProfiles(loginScope);
      const profile = profiles?.[activeRole];
      const nextProfileUsers = (profile?.users ?? []).map((user) => ({
          id: `${loginScope}-${activeRole}-${user.username}`,
          name: user.username,
          blocked: user.blocked,
        }));
      const nextSelectableUsers = nextProfileUsers.filter((user) => !user.blocked);

      setProfileUsers(nextProfileUsers);
      if (!profile) {
        if (nextSelectableUsers.length > 0) {
          setUsername(nextSelectableUsers[0].name);
        }
        return;
      }
      const listedUser = nextSelectableUsers.find((user) => user.name.trim().toLowerCase() === profile.username?.trim().toLowerCase());
      setUsername(listedUser?.name || nextSelectableUsers[0]?.name || profile.username || roleConfig.username);
      if (activeRole === "cashier" && (profile.shift === "day" || profile.shift === "night")) {
        setShift(profile.shift);
      }
    };

    applyProfiles();
    void hydrateLoginProfilesFromServer(loginScope).then(applyProfiles);

    const handleProfilesUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ key?: string }>).detail;
      if (detail?.key !== getLoginProfilesStorageKey(loginScope)) return;
      applyProfiles();
    };

    window.addEventListener("orange-hotel-storage-updated", handleProfilesUpdated as EventListener);
    return () => window.removeEventListener("orange-hotel-storage-updated", handleProfilesUpdated as EventListener);
  }, [activeRole, loginScope, roleConfig.username]);

  // Pin the hotel tier directly into the destination URL for tier-scoped logins.
  // `?tier=` is the highest-priority, deterministic signal getMawioTier reads, so
  // the dashboard tab can never fall back to the browser-wide active-login-scope
  // (which a standard session in another tab/login can overwrite) — that shared
  // fallback is what made the premium dashboards render standard data.
  const tierQuery =
    loginScope === "platinum" ? "?tier=platinum" : loginScope === "standard" ? "?tier=standard" : "";
  const loginDestination = `${roleConfig.destination}${tierQuery}`;
  const fallbackLoginScript = `
(() => {
  const formRole = ${JSON.stringify(role)};
  const loginRole = ${JSON.stringify(activeRole)};
  const destination = ${JSON.stringify(loginDestination)};
  const defaultPassword = ${JSON.stringify(roleDefaultPassword)};
  const defaultUsername = ${JSON.stringify(roleConfig.username)};
  const profilesStorageKey = ${JSON.stringify(getLoginProfilesStorageKey(loginScope))};
  const sessionUsernameKey = ${JSON.stringify(sessionUsernameKey)};
  const sessionRoleKey = ${JSON.stringify(sessionRoleKey)};
  const managerSessionKey = ${JSON.stringify(managerSessionKey)};
  const shiftStorageKey = ${JSON.stringify(shiftStorageKey)};
  const allowedUsernames = ${JSON.stringify(selectableUsers.map((user) => user.name.trim().toLowerCase()))};
  const profileUserCount = ${JSON.stringify(selectableUsers.length)};
  const runLogin = (event) => {
    event?.preventDefault();
    const form = document.querySelector("[data-role-login-form='${role}']");
    if (!form) return;
    const usernameInput = form.querySelector("[name='username']");
    const passwordInput = form.querySelector("[name='password']");
    const error = form.querySelector("[data-login-error]");
    const username = (usernameInput?.value || defaultUsername).trim();
    const password = passwordInput?.value || "";
    let profiles = {};
    try {
      profiles = JSON.parse(localStorage.getItem(profilesStorageKey) || "{}");
    } catch {
      profiles = {};
    }
    const profile = profiles?.[loginRole] || null;
    const users = Array.isArray(profile?.users) ? profile.users : [];
    const selectableUsers = users.filter((user) => user?.blocked !== true);
    const liveAllowedUsernames = selectableUsers.map((user) => String(user?.username || "").trim().toLowerCase()).filter(Boolean);
    const listedUserRequired = liveAllowedUsernames.length > 0 || profileUserCount > 0;
    const allowedNames = liveAllowedUsernames.length > 0 ? liveAllowedUsernames : allowedUsernames;
    const usernameAllowed = !listedUserRequired || allowedNames.includes(username.toLowerCase());
    const matchedUser = users.find((user) => String(user?.username || "").trim().toLowerCase() === username.toLowerCase());
    const expectedPassword = String(matchedUser?.password || profile?.password || defaultPassword).trim();
    if (matchedUser?.blocked === true || !username || !usernameAllowed || password !== expectedPassword) {
      if (error) {
        error.textContent = "Invalid username or password.";
        error.classList.remove("hidden");
      }
      return;
    }
    localStorage.setItem(sessionUsernameKey, username);
    localStorage.setItem(sessionRoleKey, loginRole);
    localStorage.setItem("orange-hotel-role", loginRole);
    localStorage.setItem("orange-hotel-username", username);
    localStorage.setItem("orange-hotel-active-login-scope", ${JSON.stringify(loginScope)});
    localStorage.setItem("mawio-tier", ${JSON.stringify(loginScope === "platinum" ? "platinum" : "standard")});
    if (loginRole === "manager") {
      localStorage.setItem(managerSessionKey, ${JSON.stringify(MANAGER_SESSION_VERSION)});
      localStorage.setItem("orange-hotel-manager-session-version", ${JSON.stringify(MANAGER_SESSION_VERSION)});
    } else {
      localStorage.removeItem(managerSessionKey);
      localStorage.removeItem("orange-hotel-manager-session-version");
    }
    if (loginRole === "cashier") {
      localStorage.setItem(shiftStorageKey, "day");
      localStorage.setItem("orange-hotel-shift", "day");
    } else {
      localStorage.removeItem(shiftStorageKey);
      localStorage.removeItem("orange-hotel-shift");
    }
    window.location.assign(destination);
  };
  const attach = () => {
    const form = document.querySelector("[data-role-login-form='" + formRole + "']");
    const button = form?.querySelector("[data-role-login-submit]");
    form?.addEventListener("submit", runLogin);
    button?.addEventListener("click", runLogin);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach, { once: true });
  } else {
    attach();
  }
})();
`;

  const handleLogin = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();

    const profiles = readLocalLoginProfiles(loginScope) ?? {};
    const currentProfile = profiles[activeRole];
    const loginUsername = username.trim() || roleConfig.username;
    const expectedPassword = getProfilePassword(currentProfile, loginUsername, roleDefaultPassword);
    const normalizedUsername = loginUsername.toLowerCase();
    const allowedUsernames = selectableUsers.map((user) => user.name.trim().toLowerCase());
    const listedUserRequired = selectableUsers.length > 0;

    if (isProfileUserBlocked(currentProfile, loginUsername)) {
      setError("This user is blocked. Contact the manager.");
      return;
    }

    if (!loginUsername || (listedUserRequired && !allowedUsernames.includes(normalizedUsername)) || password !== expectedPassword) {
      setError("Invalid username or password.");
      return;
    }

    setError("");
    localStorage.setItem(sessionUsernameKey, loginUsername);
    localStorage.setItem(sessionRoleKey, activeRole);
    localStorage.setItem("orange-hotel-role", activeRole);
    localStorage.setItem("orange-hotel-username", loginUsername);
    localStorage.setItem("orange-hotel-active-login-scope", loginScope);
    // Keep the hotel data tier in lock-step with the login scope so all synced
    // business data resolves to the correct hotel. Core logins (generic manager /
    // director) default to standard; the director can switch hotels afterwards.
    localStorage.setItem("mawio-tier", loginScope === "platinum" ? "platinum" : "standard");
    if (activeRole === "manager") {
      localStorage.setItem(managerSessionKey, MANAGER_SESSION_VERSION);
      localStorage.setItem("orange-hotel-manager-session-version", MANAGER_SESSION_VERSION);
    } else {
      localStorage.removeItem(managerSessionKey);
      localStorage.removeItem("orange-hotel-manager-session-version");
    }

    if (activeRole === "cashier") {
      localStorage.setItem(shiftStorageKey, shift);
      localStorage.setItem("orange-hotel-shift", shift);
    } else {
      localStorage.removeItem(shiftStorageKey);
      localStorage.removeItem("orange-hotel-shift");
    }

    const nextProfiles: LoginProfiles = {
      ...profiles,
      [activeRole]: {
        ...upsertProfileUser(currentProfile, loginUsername, {
          password: expectedPassword,
          updatedAt: Date.now(),
        }),
        ...(activeRole === "cashier" ? { shift } : {}),
        updatedAt: Date.now(),
      },
    };

    writeLocalLoginProfiles(nextProfiles, loginScope);
    void saveLoginProfileToServer(loginScope, activeRole, nextProfiles[activeRole]!).catch(() => undefined);

    window.location.assign(loginDestination);
  };

  return (
    <div className={cn("flex min-h-[100dvh] w-full flex-col overflow-x-hidden", isDirector ? "bg-[#f4f7f2]" : role === "standard" ? "bg-blue-100" : role === "platinum" ? "bg-amber-100" : "bg-background")}>
      <div className={cn("flex flex-1 flex-col items-center justify-center p-4 text-center sm:p-6", isDirector && "px-3 py-4 sm:px-4 sm:py-8")}>
        <div className={cn("w-full max-w-md", isDirector && "max-w-sm", isHotelTierPage && "max-w-2xl")}>
          <form data-role-login-form={role} className={cn("border bg-white p-6 text-left shadow-sm sm:p-8", isDirector ? "rounded-xl border-black/10 p-5 shadow-xl shadow-black/5" : "rounded-2xl")} onSubmit={handleLogin}>
            <script dangerouslySetInnerHTML={{ __html: fallbackLoginScript }} />

            {isHotelTierPage && (
              <div className="mb-6">
                <p className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground">{pageConfig.label}</p>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {HOTEL_LOGIN_ROLES.map((hotelRole) => {
                    const option = HOTEL_ROLE_CONFIG[hotelRole];
                    const selected = selectedRole === hotelRole;
                    return (
                      <Link
                        key={hotelRole}
                        href={`/${role}/${HOTEL_ROLE_PATHS[hotelRole]}`}
                        onClick={() => {
                          setSelectedRole(hotelRole);
                          setUsername(option.username);
                          setPassword("");
                          setError("");
                          setProfileUsers([]);
                        }}
                        className={cn(
                          "flex items-center gap-2 rounded-xl border-2 px-3 py-3 text-left transition-colors",
                          selected
                            ? role === "standard"
                              ? "border-blue-500 bg-blue-50 text-blue-900"
                              : "border-amber-500 bg-amber-50 text-amber-950"
                            : "border-transparent bg-muted/40 hover:bg-muted/70",
                        )}
                      >
                        <option.icon className="h-4 w-4 shrink-0" />
                        <span className="text-[10px] font-black uppercase tracking-wide">{option.label}</span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}

            <div className={cn(`${roleConfig.color} mb-4 flex h-12 w-12 items-center justify-center rounded-xl shadow-lg shadow-black/5`)}>
              <roleConfig.icon className="h-6 w-6 text-white" />
            </div>
            <h1 className="mb-6 text-2xl font-black tracking-tight">{roleConfig.label}</h1>

            {selectableUsers.length > 0 && (
              <div className="mb-6 grid grid-cols-2 gap-3">
                {selectableUsers.map((user) => (
                  <button
                    key={user.id}
                    type="button"
                    onClick={() => {
                      setUsername(user.name);
                      setPassword("");
                      setError("");
                    }}
                    className={cn(
                      "flex flex-col items-center p-3 rounded-xl border-2 transition-all",
                      username === user.name 
                        ? "border-orange-500 bg-orange-50" 
                        : "border-transparent bg-muted/30 hover:bg-muted/50"
                    )}
                  >
                    <div className="w-12 h-12 rounded-full mb-2 border-2 border-white shadow-sm bg-orange-100 text-orange-700 flex items-center justify-center">
                      <User className="w-5 h-5" />
                    </div>
                    <span className="text-[10px] font-black uppercase tracking-tight">{user.name}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="mb-6 space-y-3">
              <div>
                <label htmlFor={`${role}-username`} className="sr-only">Username</label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    id={`${role}-username`}
                    name="username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    className="pl-10 h-12"
                    placeholder="Enter username"
                    autoComplete="username"
                  />
                </div>
              </div>

              <div>
                <label htmlFor={`${role}-password`} className="sr-only">Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    id={`${role}-password`}
                    name="password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className="pl-10 h-12"
                    placeholder="Enter password"
                    autoComplete="current-password"
                  />
                </div>
              </div>
            </div>

            {activeRole === "cashier" && (
              <div className="mb-6 space-y-2">
                <span className="text-xs font-semibold text-muted-foreground">Shift</span>
                <Tabs value={shift} onValueChange={(value) => setShift(value as "day" | "night")} className="w-full">
                  <TabsList className="grid w-full grid-cols-2 bg-muted h-12 rounded-xl p-1">
                    <TabsTrigger value="day" className="flex items-center gap-2 font-black uppercase text-[10px] tracking-widest rounded-lg">
                      <Sun className="w-3.5 h-3.5" /> Day
                    </TabsTrigger>
                    <TabsTrigger value="night" className="flex items-center gap-2 font-black uppercase text-[10px] tracking-widest rounded-lg">
                      <Moon className="w-3.5 h-3.5" /> Night
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
            )}

            {error && (
              <p className="mb-4 text-xs font-bold text-red-600" data-login-error>{error}</p>
            )}
            {!error && <p className="mb-4 hidden text-xs font-bold text-red-600" data-login-error />}

            <Button
              type="button"
              data-role-login-submit
              onClick={() => handleLogin()}
              className="h-12 w-full rounded-xl bg-primary font-bold text-white shadow-lg shadow-primary/20 hover:bg-primary/90"
            >
              Sign in
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
