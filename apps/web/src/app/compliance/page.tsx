import { ShieldCheck } from "lucide-react";

import { ComingSoon } from "@/components/shell/coming-soon";

export default function CompliancePage() {
  return (
    <ComingSoon
      title="Compliance"
      description="KYC, AML, EDD, sanctions and PEP screening, risk scoring, and escalations."
      icon={ShieldCheck}
      phase="Phase 3"
    />
  );
}
