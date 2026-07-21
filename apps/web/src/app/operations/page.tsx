import { Activity } from "lucide-react";

import { ComingSoon } from "@/components/shell/coming-soon";

export default function OperationsPage() {
  return (
    <ComingSoon
      title="Operations"
      description="Team workload, tickets, investigations, and shift handover in one place."
      icon={Activity}
      phase="Phase 2"
    />
  );
}
