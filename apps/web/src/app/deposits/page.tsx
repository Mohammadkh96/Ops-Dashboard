import { PageHeader } from "@/components/ui/page-header";
import { type Stat } from "@/components/ui/stat-tile";
import { PaymentStats } from "@/components/payments/payment-stats";
import { TransactionsTable } from "@/components/payments/transactions-table";

// Shown only when no real payments exist yet — see PaymentStats.
const demoStats: Stat[] = [
  { label: "Today's Deposits", value: "$2.91M", delta: { text: "+12.1% vs yesterday", positive: true }, tone: "green", spark: [1.8, 2.0, 2.1, 2.4, 2.3, 2.6, 2.8, 2.91] },
  { label: "Avg Deposit", value: "$1,240", delta: { text: "+3.2%", positive: true }, tone: "blue", spark: [1.1, 1.15, 1.2, 1.18, 1.22, 1.2, 1.23, 1.24] },
  { label: "Approval Rate", value: "94.2%", delta: { text: "−0.4 pts", positive: false }, tone: "orange", spark: [95, 95, 94, 95, 94, 94, 94, 94.2] },
  { label: "Avg Processing", value: "38s", delta: { text: "−6s vs yesterday", positive: true }, tone: "purple", spark: [52, 48, 45, 44, 42, 40, 39, 38] },
];

export default function DepositsPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Deposits" description="Incoming transactions across every gateway." />
      <PaymentStats type="deposit" demo={demoStats} />
      <TransactionsTable fixedType="Deposit" />
    </div>
  );
}
