import { CreditCard } from "lucide-react";

import { ComingSoon } from "@/components/shell/coming-soon";

export default function PaymentsPage() {
  return (
    <ComingSoon
      title="Payments"
      description="Every transaction, PSP monitoring, gateway health, and reconciliation."
      icon={CreditCard}
      phase="Phase 2"
    />
  );
}
