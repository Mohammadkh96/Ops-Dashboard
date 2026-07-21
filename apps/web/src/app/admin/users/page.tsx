import { Users } from "lucide-react";

import { ComingSoon } from "@/components/shell/coming-soon";

export default function AdminUsersPage() {
  return (
    <ComingSoon
      title="Users"
      description="Manage Operations, Compliance, Support, and Executive accounts and roles."
      icon={Users}
      phase="Phase 5"
    />
  );
}
