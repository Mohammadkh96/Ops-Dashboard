import { BarChart3 } from "lucide-react";

import { ComingSoon } from "@/components/shell/coming-soon";

export default function AnalyticsPage() {
  return (
    <ComingSoon
      title="Analytics"
      description="Payment success, gateway and country performance, risk and volume trends."
      icon={BarChart3}
      phase="Phase 4"
    />
  );
}
