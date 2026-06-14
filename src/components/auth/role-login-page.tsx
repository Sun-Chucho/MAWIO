"use client";

import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Building2, Coffee, Download, Lock, Package, ShieldCheck, ShoppingCart, Smartphone, Sun, Moon, User, Utensils } from "lucide-react";
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

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

type NavigatorWithStandalone = Navigator & {
  standalone?: boolean;
};

type LoginRole = Exclude<Role, "standard" | "platinum">;
type HotelLoginRole = Exclude<LoginRole, "director">;

type LoginConfig = {
  label: string;
  username: string;
  description: string;
  color: string;
  destination: string;
  icon: typeof ShieldCheck;
};

const ROLE_CONFIG: Record<Role, LoginConfig> = {
  manager: {
    label: "Hotel Manager",
    username: "manager",
    description: "Full system oversight and operations control.",
    color: "bg-orange-500",
    destination: "/dashboard",
    icon: ShieldCheck,
  },
  director: {
    label: "Managing Director",
    username: "md",
    description: "Executive overview and strategic read-only controls.",
    color: "bg-emerald-700",
    destination: "/dashboard",
    icon: Building2,
  },
  inventory: {
    label: "Inventory Manager",
    username: "inventory",
    description: "Stock control, movements, and procurement management.",
    color: "bg-black",
    destination: "/dashboard/inventory",
    icon: Package,
  },
  cashier: {
    label: "Reception Booking",
    username: "reception",
    description: "Bookings, guest check-in, and reception payments.",
    color: "bg-orange-600",
    destination: "/dashboard/cashier",
    icon: ShoppingCart,
  },
  kitchen: {
    label: "Kitchen POS",
    username: "kitchen",
    description: "Kitchen orders, queue handling, and stock usage.",
    color: "bg-orange-700",
    destination: "/dashboard/kitchen",
    icon: Utensils,
  },
  barista: {
    label: "Barista POS",
    username: "barista",
    description: "Barista orders, beverage service, and stock usage.",
    color: "bg-orange-400",
    destination: "/dashboard/barista",
    icon: Coffee,
  },
  standard: {
    label: "Standard Hotel",
    username: "standard",
    description: "Standard hotel login page.",
    color: "bg-blue-500",
    destination: "/standard",
    icon: Sun,
  },
  platinum: {
    label: "Platinum Hotel",
    username: "platinum",
    description: "Platinum hotel login page.",
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
    description: "Reception desk, bookings, guest check-in, and payments.",
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
  const isInstallableRole = role === "director" || role === "kitchen" || role === "barista";
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
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installFeedback, setInstallFeedback] = useState("");
  const [isStandaloneApp, setIsStandaloneApp] = useState(false);
  const [isIosDevice, setIsIosDevice] = useState(false);
  const [isAndroidDevice, setIsAndroidDevice] = useState(false);
  const [serviceWorkerReady, setServiceWorkerReady] = useState(false);
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

  useEffect(() => {
    if (!isInstallableRole || typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    void navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then(() => navigator.serviceWorker.ready)
      .then(() => setServiceWorkerReady(true))
      .catch(() => setServiceWorkerReady(false));
    return () => undefined;
  }, [isInstallableRole]);

  useEffect(() => {
    if (!isInstallableRole || typeof window === "undefined") return;

    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as NavigatorWithStandalone).standalone === true;
    const userAgent = navigator.userAgent;
    const isTouchMac = /macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1;
    setIsStandaloneApp(standalone);
    setIsIosDevice(/iphone|ipad|ipod/i.test(userAgent) || isTouchMac);
    setIsAndroidDevice(/android/i.test(userAgent));

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
      setInstallFeedback("");
    };

    const handleAppInstalled = () => {
      setInstallPrompt(null);
      setInstallFeedback(`Installed. Look for ${roleConfig.label} on your desktop, home screen, or app list.`);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, [isInstallableRole, roleConfig.label]);

  const installDirectorApp = async () => {
    if (installPrompt) {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      setInstallPrompt(null);
      setInstallFeedback(
        choice.outcome === "accepted"
          ? `Installing. Look for ${roleConfig.label} on your desktop, home screen, or app list.`
          : "Installation dismissed.",
      );
      return;
    }

    if (isIosDevice) {
      setInstallFeedback("On iPhone or iPad, use Safari over HTTPS, tap Share, then Add to Home Screen. iOS does not show the Chrome-style install popup.");
      return;
    }

    if (isAndroidDevice) {
      setInstallFeedback(`On Android, open your browser menu, choose Install app or Add to Home screen, then look for ${roleConfig.label}.`);
      return;
    }

    setInstallFeedback(`Use your browser menu to install this page as an app for ${roleConfig.label}.`);
  };

  const installButtonText = installPrompt
    ? "Install Application"
    : isIosDevice
      ? "Show iPhone Steps"
      : isAndroidDevice
        ? "Show Android Steps"
        : "Show Install Steps";
  const installerStatusText = isIosDevice
    ? "iPhone install uses Safari Share"
    : serviceWorkerReady
      ? "App installer ready"
      : "Preparing app installer";
  const loginDestination = roleConfig.destination;
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
      <div className={cn("flex flex-1 flex-col items-center justify-center p-6 text-center", isDirector && "justify-start px-3 py-4 sm:px-4 sm:py-8 sm:justify-center")}>
        <div className={cn("mb-8", isDirector && "mb-4 sm:mb-6")}>
          <p className="text-muted-foreground text-[10px] uppercase tracking-[0.3em] font-black opacity-60">
            Authorized Access Only
          </p>
        </div>

        <div className={cn("w-full max-w-md", isDirector && "max-w-sm", isHotelTierPage && "max-w-2xl")}>
          <form data-role-login-form={role} className={cn("bg-white border p-8 shadow-sm text-left", isDirector ? "rounded-lg border-black/10 p-4 shadow-xl shadow-black/5 sm:p-5" : "rounded-2xl")} onSubmit={handleLogin}>
            <script dangerouslySetInnerHTML={{ __html: fallbackLoginScript }} />

            {isHotelTierPage && (
              <div className="mb-7">
                <p className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground">{pageConfig.label}</p>
                <p className="mt-2 text-sm font-medium text-muted-foreground">
                  Choose a staff role. These credentials are stored separately from the other hotel.
                </p>
                <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
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

            <div className={cn(`${roleConfig.color} w-14 h-14 rounded-lg flex items-center justify-center mb-6 shadow-lg shadow-black/5`, isDirector && "mb-4 h-12 w-12")}>
              <roleConfig.icon className="w-8 h-8 text-white" />
            </div>
            <h1 className={cn("text-2xl font-black mb-2 tracking-tight uppercase", isDirector && "text-xl sm:text-2xl")}>{roleConfig.label}</h1>
            <p className="text-sm text-muted-foreground font-medium leading-relaxed mb-6">
              {roleConfig.description}
            </p>

            {selectableUsers.length > 0 && (
              <div className="grid grid-cols-2 gap-3 mb-6">
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

            <div className={cn("space-y-4 mb-6", isDirector && "mb-4")}>
              <div className="space-y-2">
                <span className="text-[10px] font-black uppercase text-muted-foreground tracking-[0.2em]">Username</span>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    name="username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    className="pl-10 h-12"
                    placeholder="Enter username"
                    autoComplete="username"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <span className="text-[10px] font-black uppercase text-muted-foreground tracking-[0.2em]">Password</span>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
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
              <div className="space-y-3 mb-6">
                <span className="text-[10px] font-black uppercase text-muted-foreground tracking-[0.2em]">Select Shift</span>
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

            <div className={cn("mb-6 rounded-xl border bg-muted/20 px-4 py-3", isDirector && "mb-4 px-3 py-2")}>
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                Synced Default Username: {roleConfig.username}
              </p>
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mt-1">
                Default Password: {roleDefaultPassword}
              </p>
            </div>

            {error && (
              <p className="mb-4 text-xs font-bold text-red-600" data-login-error>{error}</p>
            )}
            {!error && <p className="mb-4 hidden text-xs font-bold text-red-600" data-login-error />}

            <Button
              type="button"
              data-role-login-submit
              onClick={() => handleLogin()}
              className={cn("w-full bg-primary hover:bg-primary/90 text-white font-black uppercase tracking-widest h-14 shadow-lg shadow-primary/20", isDirector ? "rounded-lg" : "rounded-xl")}
            >
              {isHotelTierPage ? `Sign In As ${roleConfig.label}` : "Enter Dashboard"}
            </Button>

            {isInstallableRole && !isStandaloneApp && (
              <div className="mt-4 rounded-lg border border-emerald-900/10 bg-[#f0f6ef] p-3 sm:p-4">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-800 text-white">
                    <Smartphone className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-black uppercase tracking-widest text-emerald-950">Install {roleConfig.label} Application</p>
                    <p className="mt-1 text-xs font-semibold leading-5 text-emerald-950/70">
                      {installPrompt
                        ? `Install this ${roleConfig.label} profile as a browser app.`
                        : isIosDevice
                          ? `Use the phone share menu to add ${roleConfig.label} to the home screen.`
                          : isAndroidDevice
                            ? `Use the browser install option so ${roleConfig.label} appears with your phone apps.`
                            : "Use your browser on desktop to install this login as an app."}
                    </p>
                  </div>
                </div>
                <div className="mt-3 rounded-lg border border-emerald-900/10 bg-white/70 px-3 py-2">
                  <p className="text-[10px] font-black uppercase tracking-widest text-emerald-900/70">
                    {installerStatusText}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-3 h-11 w-full rounded-lg border-emerald-800 bg-white text-[11px] font-black uppercase tracking-widest text-emerald-900 hover:bg-emerald-50"
                  onClick={() => void installDirectorApp()}
                >
                  <Download className="mr-2 h-4 w-4" />
                  {installButtonText}
                </Button>
                {installFeedback && (
                  <p className="mt-3 text-xs font-semibold leading-5 text-emerald-900/75">{installFeedback}</p>
                )}
              </div>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
