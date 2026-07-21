"use client";

import { useMemo, useState } from "react";

import { PageHeader } from "@/components/ui/page-header";
import { DataTable, type Column } from "@/components/ui/data-table";
import { FilterBar } from "@/components/ui/filter-bar";
import { Button } from "@/components/ui/button";
import { auditLog, type AuditEntry } from "@/lib/modules";

export default function AuditLogsPage() {
  const [search, setSearch] = useState("");

  const filtered = useMemo(
    () =>
      auditLog.filter((e) => {
        if (search) {
          const q = search.toLowerCase();
          if (
            !e.user.toLowerCase().includes(q) &&
            !e.action.toLowerCase().includes(q) &&
            !e.entityType.toLowerCase().includes(q) &&
            !e.entityId.toLowerCase().includes(q)
          )
            return false;
        }
        return true;
      }),
    [search],
  );

  const columns: Column<AuditEntry>[] = [
    {
      key: "time",
      header: "Time",
      render: (e) => <span className="tnum text-muted-foreground">{e.at}</span>,
    },
    {
      key: "user",
      header: "User",
      render: (e) =>
        e.user === "System" ? (
          <span className="text-muted">System</span>
        ) : (
          <span className="font-medium">{e.user}</span>
        ),
    },
    { key: "action", header: "Action", render: (e) => e.action },
    {
      key: "entity",
      header: "Entity",
      render: (e) => (
        <span>
          {e.entityType} ·{" "}
          <span className="font-mono text-xs text-muted-foreground">{e.entityId}</span>
        </span>
      ),
    },
    {
      key: "ip",
      header: "IP",
      render: (e) => <span className="font-mono text-xs text-muted">{e.ip}</span>,
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Audit Logs"
        description="Every action, who did it, and when."
        actions={
          <Button size="sm" variant="secondary">
            Export
          </Button>
        }
      />

      <div className="flex flex-col gap-4">
        <FilterBar
          search={search}
          onSearch={setSearch}
          searchPlaceholder="Search user, action or entity…"
        >
          <span className="ml-auto text-xs text-muted">Immutable, retained 7 years</span>
        </FilterBar>

        <DataTable
          columns={columns}
          rows={filtered}
          getRowKey={(e) => e.id}
          empty="No audit entries match this search."
        />
      </div>
    </div>
  );
}
