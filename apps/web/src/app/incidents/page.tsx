import { AlertTriangle } from "lucide-react";

import { ComingSoon } from "@/components/shell/coming-soon";

export default function IncidentsPage() {
  return (
    <ComingSoon
      title="Incidents"
      description="Severity, root cause, timeline, impact, owners, and lessons learned."
      icon={AlertTriangle}
      phase="Phase 3"
    />
  );
}
