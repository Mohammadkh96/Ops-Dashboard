"use client";

import { useMemo, useState } from "react";

import { PageHeader } from "@/components/ui/page-header";
import { StatTileRow, type Stat } from "@/components/ui/stat-tile";
import { DataTable, type Column } from "@/components/ui/data-table";
import { FilterBar } from "@/components/ui/filter-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { type OpsUser, type UserRole, type UserStatus } from "@/lib/modules";
import { useUsers } from "@/hooks/use-modules";

const ROLES: UserRole[] = [
  "Admin",
  "Operations Manager",
  "Operations",
  "Compliance",
  "Support",
  "Finance",
  "Executive",
  "Auditor",
  "Read Only",
];

const STATUSES: UserStatus[] = ["active", "invited", "suspended"];

const roleVariant = (role: UserRole) =>
  role === "Admin" ? "purple" : role === "Compliance" ? "blue" : "default";

const statusVariant = (status: UserStatus) =>
  status === "active" ? "green" : status === "invited" ? "blue" : "red";

export default function AdminUsersPage() {
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const { data: opsUsers, isLoading } = useUsers();

  const stats: Stat[] = useMemo(
    () => [
      { label: "Total users", value: String(opsUsers.length), tone: "blue" },
      { label: "Active", value: String(opsUsers.filter((u) => u.status === "active").length), tone: "green" },
      { label: "Invited", value: String(opsUsers.filter((u) => u.status === "invited").length), tone: "purple" },
      { label: "Suspended", value: String(opsUsers.filter((u) => u.status === "suspended").length), tone: "orange" },
    ],
    [opsUsers],
  );

  const filtered = useMemo(
    () =>
      opsUsers.filter((u) => {
        if (role && u.role !== role) return false;
        if (status && u.status !== status) return false;
        if (search) {
          const q = search.toLowerCase();
          if (!u.name.toLowerCase().includes(q) && !u.email.toLowerCase().includes(q)) return false;
        }
        return true;
      }),
    [opsUsers, search, role, status],
  );

  const columns: Column<OpsUser>[] = [
    {
      key: "user",
      header: "User",
      render: (u) => (
        <div className="flex items-center gap-3">
          <Avatar>
            <AvatarFallback>{u.initials}</AvatarFallback>
          </Avatar>
          <div className="flex flex-col">
            <span className="font-medium">{u.name}</span>
            <span className="text-xs text-muted">{u.email}</span>
          </div>
        </div>
      ),
    },
    {
      key: "role",
      header: "Role",
      render: (u) => <Badge variant={roleVariant(u.role)}>{u.role}</Badge>,
    },
    {
      key: "status",
      header: "Status",
      render: (u) => (
        <Badge variant={statusVariant(u.status)}>
          {u.status[0].toUpperCase() + u.status.slice(1)}
        </Badge>
      ),
    },
    {
      key: "lastActive",
      header: "Last active",
      render: (u) => <span className="tnum text-muted">{u.lastActive}</span>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: () => (
        <Button variant="ghost" size="sm">
          Manage
        </Button>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Users"
        description="Manage accounts, roles and access."
        actions={<Button size="sm">Invite user</Button>}
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
              options: ROLES.map((r) => ({ label: r, value: r })),
            },
            {
              label: "Status",
              value: status,
              onChange: setStatus,
              options: STATUSES.map((s) => ({ label: s[0].toUpperCase() + s.slice(1), value: s })),
            },
          ]}
        >
          <span className="ml-auto text-xs text-muted">
            {filtered.length} of {opsUsers.length}
          </span>
        </FilterBar>

        <DataTable
          columns={columns}
          rows={filtered}
          getRowKey={(u) => u.id}
          loading={isLoading}
          empty="No users match these filters."
        />
      </div>
    </div>
  );
}
