import { Settings } from "lucide-react";

import { ComingSoon } from "@/components/shell/coming-soon";

export default function SettingsPage() {
  return (
    <ComingSoon
      title="Settings"
      description="Profile, notifications, integrations, and workspace preferences."
      icon={Settings}
      phase="Phase 5"
    />
  );
}
