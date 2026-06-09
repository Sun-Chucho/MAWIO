"use client";

import { useEffect, useMemo, useState } from "react";
import { USERS, Role } from "@/app/lib/mock-data";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Calendar,
  Ban,
  Mail,
  Phone,
  Plus,
  Search,
  Trash2,
  Users,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIsDirector } from "@/hooks/use-is-director";
import { readJson, writeJson } from "@/app/lib/storage";
import { subscribeToSyncedStorageKey } from "@/app/lib/firebase-sync";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DEFAULT_LOGIN_PASSWORD,
  getProfilePassword,
  LoginProfiles,
  readLocalLoginProfiles,
  saveLoginProfileToServer,
  STORAGE_LOGIN_PROFILES,
  upsertProfileUser,
  writeLocalLoginProfiles,
} from "@/app/lib/login-profiles";

type StaffRoleFilter = "all" | Role;

interface StaffMember {
  id: string;
  name: string;
  role: Role;
  avatar: string;
  phone: string;
  email: string;
  shift: "Day" | "Night";
  blocked?: boolean;
}

const ROLE_OPTIONS: Role[] = ["manager", "director", "inventory", "cashier", "kitchen", "barista"];
const DEFAULT_ROLE_USERNAMES: Record<Role, string> = {
  manager: "manager",
  director: "md",
  inventory: "inventory",
  cashier: "reception",
  kitchen: "kitchen",
  barista: "barista",
  standard: "standard",
  platinum: "platinum",
};
const STAFF_STORAGE_KEY = "orange-hotel-staff-members";
const DEFAULT_BARISTA_STAFF: StaffMember[] = [
  {
    id: "barista-1",
    name: "ALI",
    role: "barista",
    avatar: "/logo.jpeg",
    phone: "+255 000 000 001",
    email: "ali@orange.hotel",
    shift: "Day",
    blocked: false,
  },
  {
    id: "barista-2",
    name: "USER 2",
    role: "barista",
    avatar: "/logo.jpeg",
    phone: "+255 000 000 002",
    email: "user.2@orange.hotel",
    shift: "Day",
    blocked: false,
  },
];

function toEmail(name: string) {
  return `${name.toLowerCase().replace(/\s+/g, ".")}@orange.hotel`;
}

function getDefaultMembers(): StaffMember[] {
  return [
    ...USERS.map((user) => ({
      ...user,
      phone: `+1 (555) 000-00${user.id.slice(-1)}`,
      email: toEmail(user.name),
      shift: user.id === "u4" ? "Night" as const : "Day" as const,
    })),
    ...DEFAULT_BARISTA_STAFF,
  ];
}

function normalizeStaffName(value: string) {
  return value.trim().toLowerCase();
}

function getProfileMembers(profiles: LoginProfiles | null): StaffMember[] {
  if (!profiles) return [];
  return ROLE_OPTIONS.flatMap((role) =>
    (
      profiles[role]?.users?.length
        ? profiles[role]?.users ?? []
        : profiles[role]?.username
          ? [{ username: profiles[role]!.username, blocked: false, updatedAt: profiles[role]!.updatedAt }]
          : []
    ).map((user) => ({
      id: `${role}-${normalizeStaffName(user.username).replace(/\s+/g, "-")}`,
      name: user.username,
      role,
      avatar: "/logo.jpeg",
      phone: "+255 000 000 000",
      email: toEmail(user.username),
      shift: profiles[role]?.shift === "night" ? "Night" as const : "Day" as const,
      blocked: user.blocked === true,
    })),
  );
}

function reconcileMembersWithProfiles(storedMembers: StaffMember[], profileMembers: StaffMember[]) {
  if (profileMembers.length === 0) {
    return storedMembers.length > 0 ? storedMembers : getDefaultMembers();
  }

  const storedByRoleAndName = new Map(
    storedMembers.map((member) => [`${member.role}:${normalizeStaffName(member.name)}`, member]),
  );

  return profileMembers.map((profileMember) => {
    const storedMember = storedByRoleAndName.get(`${profileMember.role}:${normalizeStaffName(profileMember.name)}`);
    return {
      ...profileMember,
      id: storedMember?.id ?? profileMember.id,
      avatar: storedMember?.avatar ?? profileMember.avatar,
      phone: storedMember?.phone ?? profileMember.phone,
      email: storedMember?.email ?? profileMember.email,
      shift: profileMember.shift,
      blocked: profileMember.blocked,
    };
  });
}

export default function StaffPage() {
  const isDirector = useIsDirector();
  const [members, setMembers] = useState<StaffMember[]>([]);

  const [searchTerm, setSearchTerm] = useState("");
  const [roleFilter, setRoleFilter] = useState<StaffRoleFilter>("all");
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedMember, setSelectedMember] = useState<StaffMember | null>(null);

  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState<Role>("cashier");
  const [newShift, setNewShift] = useState<"Day" | "Night">("Day");
  const [newPassword, setNewPassword] = useState(DEFAULT_LOGIN_PASSWORD);

  const persistMembers = (nextMembers: StaffMember[]) => {
    setMembers(nextMembers);
    writeJson(STAFF_STORAGE_KEY, nextMembers);
  };

  const saveRoleProfile = async (role: Role, username: string, password?: string, blocked = false) => {
    const profiles = readLocalLoginProfiles() ?? {};
    const nextEntry = upsertProfileUser(profiles[role], username, {
      ...(password ? { password } : {}),
      blocked,
      updatedAt: Date.now(),
    });
    const nextProfiles: LoginProfiles = {
      ...profiles,
      [role]: nextEntry,
    };
    writeLocalLoginProfiles(nextProfiles);
    await saveLoginProfileToServer(role, nextEntry);
  };

  const removeRoleProfileUser = async (role: Role, username: string) => {
    const profiles = readLocalLoginProfiles() ?? {};
    const entry = profiles[role];
    if (!entry) return;

    const nextUsers = (entry.users ?? []).filter((user) => user.username.trim().toLowerCase() !== username.trim().toLowerCase());
    const nextEntry = {
      ...entry,
      username: nextUsers[0]?.username ?? DEFAULT_ROLE_USERNAMES[role],
      users: nextUsers,
      updatedAt: Date.now(),
    };
    const nextProfiles: LoginProfiles = {
      ...profiles,
      [role]: nextEntry,
    };
    writeLocalLoginProfiles(nextProfiles);
    await saveLoginProfileToServer(role, nextEntry);
  };

  useEffect(() => {
    const applyMembers = (incomingMembers?: StaffMember[] | null) => {
      const storedMembers = incomingMembers ?? readJson<StaffMember[]>(STAFF_STORAGE_KEY);
      const profiles = readLocalLoginProfiles();
      const storedList = Array.isArray(storedMembers) ? storedMembers : [];
      const nextMembers = reconcileMembersWithProfiles(storedList, getProfileMembers(profiles));
      setMembers(nextMembers);
      if (JSON.stringify(nextMembers) !== JSON.stringify(storedMembers ?? [])) {
        writeJson(STAFF_STORAGE_KEY, nextMembers);
      }
    };

    applyMembers();
    const unsubscribeStaff = subscribeToSyncedStorageKey<StaffMember[]>(STAFF_STORAGE_KEY, (value) => {
      applyMembers(value);
    });
    const unsubscribeProfiles = subscribeToSyncedStorageKey<LoginProfiles>(STORAGE_LOGIN_PROFILES, () => {
      applyMembers();
    });

    return () => {
      unsubscribeStaff();
      unsubscribeProfiles();
    };
  }, []);

  const filteredMembers = useMemo(() => {
    return members.filter((member) => {
      const inSearch =
        member.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        member.role.toLowerCase().includes(searchTerm.toLowerCase());
      const inRole = roleFilter === "all" || member.role === roleFilter;
      return inSearch && inRole;
    });
  }, [members, roleFilter, searchTerm]);

  const addMember = async () => {
    if (newName.trim().length === 0) return;

    const id = `u-${Date.now()}`;
    const username = newName.trim();
    const member: StaffMember = {
      id,
      name: username,
      role: newRole,
      avatar: "/logo.jpeg",
      phone: `+1 (555) 300-${Math.floor(1000 + Math.random() * 9000)}`,
      email: toEmail(newName.trim()),
      shift: newShift,
      blocked: false,
    };

    persistMembers([member, ...members]);
    await saveRoleProfile(newRole, username, newPassword.trim() || DEFAULT_LOGIN_PASSWORD, false);
    setNewName("");
    setNewRole("cashier");
    setNewShift("Day");
    setNewPassword(DEFAULT_LOGIN_PASSWORD);
    setShowAddForm(false);
  };

  const updateMemberRole = async (memberId: string, role: Role) => {
    if (isDirector) return;

    const currentMember = members.find((member) => member.id === memberId);
    if (!currentMember || currentMember.role === role) return;

    const nextMembers = members.map((member) =>
      member.id === memberId ? { ...member, role } : member,
    );
    const profiles = readLocalLoginProfiles() ?? {};
    const currentPassword = getProfilePassword(profiles[currentMember.role], currentMember.name, DEFAULT_LOGIN_PASSWORD);
    persistMembers(nextMembers);
    await removeRoleProfileUser(currentMember.role, currentMember.name);
    await saveRoleProfile(role, currentMember.name, currentPassword, currentMember.blocked === true);
  };

  const deleteMember = async (memberId: string) => {
    if (isDirector) return;

    const currentMember = members.find((member) => member.id === memberId);
    if (!currentMember) return;

    persistMembers(members.filter((member) => member.id !== memberId));
    await removeRoleProfileUser(currentMember.role, currentMember.name);
  };

  const toggleMemberBlocked = async (memberId: string) => {
    if (isDirector) return;

    const currentMember = members.find((member) => member.id === memberId);
    if (!currentMember) return;

    const nextBlocked = !currentMember.blocked;
    persistMembers(members.map((member) => (member.id === memberId ? { ...member, blocked: nextBlocked } : member)));
    await saveRoleProfile(currentMember.role, currentMember.name, undefined, nextBlocked);
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
        <div>
          <h1 className="text-3xl font-black tracking-tight">Staff Directory</h1>
          <p className="text-muted-foreground text-sm uppercase font-bold tracking-wider">Human resources and shift planning</p>
        </div>
        <Button className="bg-primary hover:bg-primary/90 font-bold" onClick={() => !isDirector && setShowAddForm((current) => !current)} disabled={isDirector}>
          <Plus className="w-4 h-4 mr-2" /> {isDirector ? "Read Only" : showAddForm ? "Close Form" : "Add Staff Member"}
        </Button>
      </header>

      {showAddForm && !isDirector && (
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="p-4 grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
            <Input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Full name" />
            <select
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              value={newRole}
              onChange={(event) => setNewRole(event.target.value as Role)}
            >
              {ROLE_OPTIONS.map((role) => (
                <option key={role} value={role}>{role}</option>
              ))}
            </select>
            <select
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              value={newShift}
              onChange={(event) => setNewShift(event.target.value as "Day" | "Night")}
            >
              <option value="Day">Day Shift</option>
              <option value="Night">Night Shift</option>
            </select>
            <Input value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="Login password" />
            <Button className="font-bold" onClick={() => void addMember()}>Save Staff</Button>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-col md:flex-row gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Search staff by name or role..." className="pl-10" value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} />
        </div>

        <Tabs value={roleFilter} onValueChange={(value) => setRoleFilter(value as StaffRoleFilter)}>
          <TabsList className="h-auto min-h-10 flex-wrap justify-start">
            <TabsTrigger value="all" className="text-[10px] font-black uppercase tracking-widest">All</TabsTrigger>
            {ROLE_OPTIONS.map((role) => (
              <TabsTrigger key={role} value={role} className="text-[10px] font-black uppercase tracking-widest">
                {role === "cashier" ? "Reception" : role}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredMembers.map((member) => (
          <Card key={member.id} className="group hover:shadow-xl transition-all border-none shadow-sm relative overflow-hidden bg-white">
            <CardHeader className="flex flex-row items-start justify-between pb-2">
              <Avatar className="w-16 h-16 rounded-2xl shadow-lg border-2 border-white">
                <AvatarImage src={member.avatar} />
                <AvatarFallback className="bg-primary text-white font-black">{member.name[0]}</AvatarFallback>
              </Avatar>
              <Badge variant="outline" className="text-[10px] uppercase font-black tracking-widest bg-white border-primary/30">
                {member.shift}
              </Badge>
            </CardHeader>
            <CardContent>
              <div className="mb-4">
                <h3 className="text-xl font-black tracking-tight">{member.name}</h3>
                <div className="flex items-center gap-2 mt-1">
                  <Badge variant="secondary" className="text-[10px] uppercase font-black tracking-widest bg-black text-white px-2">
                    {member.role}
                  </Badge>
                  <span className="flex items-center gap-1 text-[10px] font-black text-green-500 uppercase">
                    <div className={`w-1.5 h-1.5 rounded-full ${member.blocked ? "bg-red-500" : "bg-green-500"}`} />
                    {member.blocked ? "Blocked" : "Active"}
                  </span>
                </div>
              </div>

              <div className="space-y-3 pt-4 border-t">
                <a href={`tel:${member.phone}`} className="flex items-center gap-2 text-xs text-muted-foreground font-bold hover:text-primary">
                  <Phone className="w-3 h-3" /> {member.phone}
                </a>
                <a href={`mailto:${member.email}`} className="flex items-center gap-2 text-xs text-muted-foreground font-bold hover:text-primary">
                  <Mail className="w-3 h-3" /> {member.email}
                </a>
                <div className="flex items-center gap-2 text-xs text-muted-foreground font-bold">
                  <Calendar className="w-3 h-3" /> Full Time | Shift {member.shift}
                </div>
              </div>

              <div className="mt-6 space-y-2">
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-[10px] font-black uppercase tracking-widest"
                  value={member.role}
                  onChange={(event) => void updateMemberRole(member.id, event.target.value as Role)}
                  disabled={isDirector}
                >
                  {ROLE_OPTIONS.map((role) => (
                    <option key={role} value={role}>{role}</option>
                  ))}
                </select>
                <div className="grid grid-cols-3 gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="font-bold text-[10px] uppercase tracking-widest"
                    onClick={() => setSelectedMember(member)}
                  >
                    Profile
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="font-bold text-[10px] uppercase tracking-widest"
                    disabled={isDirector}
                    onClick={() => void toggleMemberBlocked(member.id)}
                  >
                    <Ban className="mr-1 h-3 w-3" /> {member.blocked ? "Unblock" : "Block"}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="font-bold text-[10px] uppercase tracking-widest"
                    disabled={isDirector}
                    onClick={() => void deleteMember(member.id)}
                  >
                    <Trash2 className="mr-1 h-3 w-3" /> Remove
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {filteredMembers.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center opacity-50">
            <Users className="w-10 h-10 mx-auto mb-3" />
            <p className="font-black uppercase tracking-widest text-xs">No staff match this filter</p>
          </CardContent>
        </Card>
      )}

      <Dialog open={Boolean(selectedMember)} onOpenChange={(open) => !open && setSelectedMember(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl font-black tracking-tight">Staff Profile</DialogTitle>
            <DialogDescription>Saved staff details for this account.</DialogDescription>
          </DialogHeader>
          {selectedMember && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Name</p>
                  <p className="mt-1 font-bold">{selectedMember.name}</p>
                </div>
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Role</p>
                  <p className="mt-1 font-bold">{selectedMember.role}</p>
                </div>
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Shift</p>
                  <p className="mt-1 font-bold">{selectedMember.shift}</p>
                </div>
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Phone</p>
                  <p className="mt-1 font-bold">{selectedMember.phone}</p>
                </div>
              </div>
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Email</p>
                <p className="mt-1 font-bold break-all">{selectedMember.email}</p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedMember(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
