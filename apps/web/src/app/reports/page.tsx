import { FileText } from "lucide-react";

import { ComingSoon } from "@/components/shell/coming-soon";

export default function ReportsPage() {
  return (
    <ComingSoon
      title="Reports"
      description="Generate, schedule, and email PDF and Excel reports."
      icon={FileText}
      phase="Phase 4"
    />
  );
}
