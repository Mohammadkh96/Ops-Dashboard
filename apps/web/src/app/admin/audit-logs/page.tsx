import { ScrollText } from "lucide-react";

import { ComingSoon } from "@/components/shell/coming-soon";

export default function AuditLogsPage() {
  return (
    <ComingSoon
      title="Audit Logs"
      description="Every action, user, timestamp, IP, and before/after value across OpsOS."
      icon={ScrollText}
      phase="Phase 5"
    />
  );
}
