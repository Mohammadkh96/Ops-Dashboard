"use client";

import { useMemo, useState } from "react";
import { KeyRound, Plus, ShieldCheck } from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import { StatTileRow, type Stat } from "@/components/ui/stat-tile";
import { DataTable, type Column } from "@/components/ui/data-table";
import { FilterBar } from "@/components/ui/filter-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useToast } from "@/components/ui/toast";
import { useAuth } from "@/lib/auth";
import {
  roleLabel,
  useAdminRoles,
  useAdminUsers,
  useUserAdmin,
  type AdminUser,
} from "@/hooks/use-admin";

const field =
  "h-10 w-full rounded-lg border border-border bg-card px-3 text-sm outline-none focus:border-border-strong";
const label = "text-[10px] font-medium uppercase tracking-wider text-muted";

const initialsOf = (u: AdminUser) =>
  `${u.firstName?.[0] ?? ""}${u.lastName?.[0] ?? ""}`.toUpperCase() ||
  u.email.slice(0, 2).toUpperCase();

const roleVariant = (role: string) =>
  role === "ADMIN"
    ? "purple"
    : role === "OPERATIONS_MANAGER"
      ? "blue"
      : role === "READ_ONLY"
        ? "default"
        : "default";

/**
 * Accounts.
 *
 * The screen used to be a list with a dead "Invite user" button and fabricated
 * ids, so nothing on it could address a real account. It now reads and writes
 * the real ones, behind the admin lock.
 *
 * ADDING SOMEBODY DOES NOT SEND ANYTHING. The account is created with the right
 * role and no password, and the first time they press "Continue with Google"
 * they land in it. There is nothing to send, nothing to type and nothing to
 * leak in a chat message — which is also why there is no invitation email to
 * fail silently when mail is unconfigured. A temporary password is there for
 * the case Google cannot cover.
 */
export default function AdminUsersPage() {
  const { user: me } = useAuth();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState<AdminUser | null>(null);

  const { data, isLoading, isError, error } = useAdminUsers();
  const roles = useAdminRoles();
  // Memoised: the useMemos below take it as a dependency, and `data ?? []`
  // hands them a fresh array on every render.
  const users = useMemo(() => data ?? [], [data]);
  const roleOptions = roles.data ?? [];

  const stats: Stat[] = useMemo(
    () => [
      { label: "Accounts", value: String(users.length), tone: "blue" },
      {
        label: "Active",
        value: String(users.filter((u) => u.status === "active").length),
        tone: "green",
      },
      {
        label: "Administrators",
        value: String(
          users.filter((u) => u.role === "ADMIN" && u.status === "active").length,
        ),
        tone: "purple",
      },
      {
        label: "Deactivated",
        value: String(users.filter((u) => u.status === "disabled").length),
        tone: users.some((u) => u.status === "disabled") ? "orange" : "green",
      },
    ],
    [users],
  );

  const filtered = useMemo(
    () =>
      users.filter((u) => {
        if (role && u.role !== role) return false;
        if (status && u.status !== status) return false;
        if (search) {
          const q = search.toLowerCase();
          if (
            !u.name.toLowerCase().includes(q) &&
            !u.email.toLowerCase().includes(q)
          )
            return false;
        }
        return true;
      }),
    [users, search, role, status],
  );

  const columns: Column<AdminUser>[] = [
    {
      key: "user",
      header: "User",
      render: (u) => (
        <div className="flex items-center gap-3">
          <Avatar>
            <AvatarFallback>{initialsOf(u)}</AvatarFallback>
          </Avatar>
          <div className="flex flex-col">
            <span className="font-medium">
              {u.name}
              {u.id === me?.userId ? (
                <span className="ml-1.5 text-[10px] text-muted">(you)</span>
              ) : null}
            </span>
            <span className="text-xs text-muted">{u.email}</span>
          </div>
        </div>
      ),
    },
    {
      key: "role",
      header: "Role",
      render: (u) => <Badge variant={roleVariant(u.role)}>{roleLabel(u.role)}</Badge>,
    },
    {
      key: "signin",
      header: "Signs in with",
      // The question this screen is most often opened to answer is "why can't
      // Sara get in?", and it is unanswerable from a name and a role.
      render: (u) => (
        <div className="flex flex-wrap items-center gap-1">
          {u.google ? (
            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
              Google
            </span>
          ) : null}
          {u.hasPassword ? (
            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
              Password
            </span>
          ) : null}
          {!u.google && !u.hasPassword ? (
            <span className="text-[11px] text-muted">Google, once they try</span>
          ) : null}
          {u.adminUnlockSet ? (
            <span
              title="Has set an admin passphrase"
              className="flex items-center gap-0.5 rounded border border-accent-purple/25 px-1.5 py-0.5 text-[10px] text-accent-purple"
            >
              <ShieldCheck className="size-2.5" /> Unlock
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (u) => (
        <Badge variant={u.status === "active" ? "green" : "red"}>
          {u.status === "active" ? "Active" : "Deactivated"}
        </Badge>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (u) => (
        <Button variant="ghost" size="sm" onClick={() => setManaging(u)}>
          Manage
        </Button>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Users"
        description="Accounts, roles and how each person gets in."
        actions={
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            Add user
          </Button>
        }
      />

      <StatTileRow stats={stats} />

      <div className="flex flex-col gap-4">
        <FilterBar
          search={search}
          onSearch={setSearch}
          searchPlaceholder="Search name or email…"
          filters={[
            {
              label: "Role",
              value: role,
              onChange: setRole,
              options: roleOptions.map((r) => ({ label: roleLabel(r), value: r })),
            },
            {
              label: "Status",
              value: status,
              onChange: setStatus,
              options: [
                { label: "Active", value: "active" },
                { label: "Deactivated", value: "disabled" },
              ],
            },
          ]}
        >
          <span className="ml-auto text-xs text-muted">
            {filtered.length} of {users.length}
          </span>
        </FilterBar>

        {isError ? (
          <p className="rounded-lg border border-accent-red/25 bg-accent-red-soft px-3 py-2 text-xs text-accent-red">
            Could not read the accounts: {String(error)}
          </p>
        ) : null}

        <DataTable
          columns={columns}
          rows={filtered}
          getRowKey={(u) => u.id}
          loading={isLoading}
          empty="No accounts match these filters."
        />
      </div>

      <Drawer
        open={adding}
        onOpenChange={setAdding}
        title="Add user"
        subtitle="Creates the account. They sign in with their work Google account."
      >
        <AddUser
          roles={roleOptions}
          onDone={(email) => {
            setAdding(false);
            toast({ kind: "success", title: `${email} can now sign in` });
          }}
        />
      </Drawer>

      <Drawer
        open={!!managing}
        onOpenChange={(o) => !o && setManaging(null)}
        title={managing ? managing.name : "Manage"}
        subtitle={managing?.email}
      >
        {managing ? (
          <ManageUser
            user={managing}
            isMe={managing.id === me?.userId}
            roles={roleOptions}
            onDone={(message) => {
              setManaging(null);
              toast({ kind: "success", title: message });
            }}
          />
        ) : null}
      </Drawer>
    </div>
  );
}

/** The add form. */
function AddUser({
  roles,
  onDone,
}: {
  roles: string[];
  onDone: (email: string) => void;
}) {
  const { create } = useUserAdmin();
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  // READ_ONLY by default, on purpose: the default has to be the one that grants
  // nothing, and promoting somebody is a decision worth taking deliberately.
  const [role, setRole] = useState("READ_ONLY");
  const [withPassword, setWithPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    create.mutate(
      {
        email: email.trim(),
        firstName: firstName.trim() || undefined,
        lastName: lastName.trim() || undefined,
        role,
        password: withPassword ? password : undefined,
      },
      {
        onSuccess: (u) => onDone(u.email),
        onError: (e: unknown) =>
          setError(e instanceof Error ? e.message : String(e)),
      },
    );
  };

  const passwordTooShort = withPassword && password.length > 0 && password.length < 10;

  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className={label}>Work email</span>
        <input
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="sara@tradin.com"
          className={field}
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1.5">
          <span className={label}>First name</span>
          <input
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            className={field}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={label}>Last name</span>
          <input
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            className={field}
          />
        </label>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className={label}>Role</span>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className={`${field} cursor-pointer`}
        >
          {roles.map((r) => (
            <option key={r} value={r}>
              {roleLabel(r)}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-muted">
          Read Only grants nothing. Promote them once they need more.
        </span>
      </label>

      <div className="flex flex-col gap-2 rounded-lg border border-border bg-card/40 px-3 py-2.5">
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            checked={withPassword}
            onChange={(e) => setWithPassword(e.target.checked)}
            className="mt-0.5"
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-xs font-medium">Give them a password too</span>
            <span className="text-[11px] text-muted">
              Only needed for somebody outside the company Google — a
              contractor, or a break-glass account. Otherwise they just press
              &ldquo;Continue with Google&rdquo;.
            </span>
          </span>
        </label>
        {withPassword ? (
          <>
            <input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 10 characters"
              className={field}
            />
            <span className="text-[11px] text-muted">
              Shown as you type, because you have to pass it on — nothing is
              emailed.
            </span>
          </>
        ) : null}
      </div>

      {error ? (
        <p className="rounded-lg border border-accent-red/25 bg-accent-red-soft px-3 py-2 text-xs text-accent-red">
          {error}
        </p>
      ) : null}

      <Button
        onClick={submit}
        disabled={
          create.isPending ||
          !email.trim() ||
          passwordTooShort ||
          (withPassword && !password)
        }
      >
        {create.isPending ? "Creating…" : "Create account"}
      </Button>
    </div>
  );
}

/** The manage panel for one account. */
function ManageUser({
  user,
  isMe,
  roles,
  onDone,
}: {
  user: AdminUser;
  isMe: boolean;
  roles: string[];
  onDone: (message: string) => void;
}) {
  const { update, setPassword, clearPassword, resetAdminPassphrase } =
    useUserAdmin();
  const [role, setRole] = useState(user.role);
  const [newPassword, setNewPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fail = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));

  return (
    <div className="flex flex-col gap-5">
      {isMe ? (
        // Said before they try, not after. The server refuses both anyway, but
        // discovering a rule by being refused is worse than being told.
        <p className="rounded-lg border border-accent-orange/25 bg-accent-orange-soft px-3 py-2 text-xs text-accent-orange">
          This is your own account. You cannot change your own role or
          deactivate yourself — ask another administrator.
        </p>
      ) : null}

      <label className="flex flex-col gap-1.5">
        <span className={label}>Role</span>
        <select
          value={role}
          disabled={isMe}
          onChange={(e) => setRole(e.target.value)}
          className={`${field} cursor-pointer disabled:cursor-not-allowed disabled:opacity-50`}
        >
          {roles.map((r) => (
            <option key={r} value={r}>
              {roleLabel(r)}
            </option>
          ))}
        </select>
        {role !== user.role ? (
          <Button
            size="sm"
            className="self-start"
            disabled={update.isPending}
            onClick={() => {
              setError(null);
              update.mutate(
                { id: user.id, role },
                {
                  onSuccess: () =>
                    onDone(`${user.name} is now ${roleLabel(role)}`),
                  onError: fail,
                },
              );
            }}
          >
            {update.isPending ? "Saving…" : `Change to ${roleLabel(role)}`}
          </Button>
        ) : null}
      </label>

      <div className="flex flex-col gap-1.5">
        <span className={label}>Access</span>
        <p className="text-xs text-muted">
          {user.status === "active"
            ? "Deactivating keeps everything they have done — shifts, incidents, audit entries — and stops them signing in."
            : "Re-enabling lets them sign in again with the role below."}
        </p>
        <Button
          size="sm"
          variant={user.status === "active" ? "destructive" : "secondary"}
          className="self-start"
          disabled={isMe || update.isPending}
          onClick={() => {
            setError(null);
            const next = user.status !== "active";
            update.mutate(
              { id: user.id, isActive: next },
              {
                onSuccess: () =>
                  onDone(
                    next
                      ? `${user.name} can sign in again`
                      : `${user.name} is deactivated`,
                  ),
                onError: fail,
              },
            );
          }}
        >
          {user.status === "active" ? "Deactivate" : "Re-enable"}
        </Button>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <span className={label}>Password</span>
        <p className="text-xs text-muted">
          {user.hasPassword
            ? "They can sign in with a password as well as Google."
            : "No password — Google is the only way into this account."}
        </p>

        {showPassword ? (
          <div className="flex flex-col gap-2">
            <input
              type="text"
              autoFocus
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="At least 10 characters"
              className={field}
            />
            <span className="text-[11px] text-muted">
              Nothing is emailed. You are holding this and have to pass it on.
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={setPassword.isPending || newPassword.length < 10}
                onClick={() => {
                  setError(null);
                  setPassword.mutate(
                    { id: user.id, password: newPassword },
                    {
                      onSuccess: () =>
                        onDone(`Password set for ${user.email}`),
                      onError: fail,
                    },
                  );
                }}
              >
                {setPassword.isPending ? "Saving…" : "Set it"}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setShowPassword(false);
                  setNewPassword("");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setShowPassword(true)}
            >
              <KeyRound className="size-3.5" />
              {user.hasPassword ? "Set a new one" : "Give them a password"}
            </Button>
            {user.hasPassword ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={clearPassword.isPending}
                onClick={() => {
                  setError(null);
                  clearPassword.mutate(user.id, {
                    onSuccess: () =>
                      onDone(`${user.email} now signs in with Google only`),
                    onError: fail,
                  });
                }}
              >
                Remove it — Google only
              </Button>
            ) : null}
          </div>
        )}
      </div>

      {user.role === "ADMIN" && user.adminUnlockSet && !isMe ? (
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <span className={label}>Admin passphrase</span>
          <p className="text-xs text-muted">
            Clearing it lets them set a new one next time they open this tab.
            This is the only way back in for somebody who has forgotten theirs —
            there is no master key.
          </p>
          <Button
            size="sm"
            variant="secondary"
            className="self-start"
            disabled={resetAdminPassphrase.isPending}
            onClick={() => {
              setError(null);
              resetAdminPassphrase.mutate(user.id, {
                onSuccess: () =>
                  onDone(`${user.email} can set a new admin passphrase`),
                onError: fail,
              });
            }}
          >
            {resetAdminPassphrase.isPending ? "Clearing…" : "Clear it"}
          </Button>
        </div>
      ) : null}

      {error ? (
        <p className="rounded-lg border border-accent-red/25 bg-accent-red-soft px-3 py-2 text-xs text-accent-red">
          {error}
        </p>
      ) : null}
    </div>
  );
}
