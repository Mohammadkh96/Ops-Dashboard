import { ArrowUpFromLine } from "lucide-react";

import { ComingSoon } from "@/components/shell/coming-soon";

export default function WithdrawalsPage() {
  return (
    <ComingSoon
      title="Withdrawals"
      description="Withdrawal queue, approvals, risk flags, and processing times."
      icon={ArrowUpFromLine}
      phase="Phase 2"
    />
  );
}
