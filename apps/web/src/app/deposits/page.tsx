import { ArrowDownToLine } from "lucide-react";

import { ComingSoon } from "@/components/shell/coming-soon";

export default function DepositsPage() {
  return (
    <ComingSoon
      title="Deposits"
      description="Live deposit transactions filtered by client, country, PSP, and status."
      icon={ArrowDownToLine}
      phase="Phase 2"
    />
  );
}
