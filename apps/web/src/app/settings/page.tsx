"use client";

import { useState } from "react";
import type { ReactNode } from "react";

import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

const TABS = [
  { key: "profile", label: "Profile" },
  { key: "notifications", label: "Notifications" },
  { key: "integrations", label: "Integrations" },
  { key: "security", label: "Security" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const inputClass =
  "h-10 rounded-lg border border-border bg-card px-3 text-sm outline-none focus:border-border-strong";

const selectClass =
  "h-10 cursor-pointer appearance-none rounded-lg border border-border bg-card pl-3 pr-8 text-sm text-foreground outline-none transition-colors hover:border-border-strong focus:border-border-strong";

const labelClass = "text-xs font-medium text-muted-foreground";

const sectionLabelClass = "text-xs uppercase tracking-wider text-muted";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className={labelClass}>{label}</span>
      {children}
    </label>
  );
}

function SelectField({
  label,
  defaultValue,
  options,
}: {
  label: string;
  defaultValue: string;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className={labelClass}>{label}</span>
      <div className="relative">
        <select defaultValue={defaultValue} className={cn(selectClass, "w-full")}>
          {options.map((o) => (
            <option key={o.value} value={o.value} className="bg-card text-foreground">
              {o.label}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted">
          ▾
        </span>
      </div>
    </div>
  );
}

function ProfileTab() {
  return (
    <Card className="glass card-seam">
      <CardHeader>
        <CardTitle>Profile</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Full name">
            <input type="text" defaultValue="Mohammad K." className={inputClass} />
          </Field>
          <Field label="Email">
            <input
              type="email"
              defaultValue="mohammad@tradin.com"
              readOnly
              disabled
              className={cn(inputClass, "cursor-not-allowed text-muted-foreground opacity-70")}
            />
          </Field>
        </div>

        <Separator />

        <div className="flex flex-col gap-1.5">
          <span className={labelClass}>Role</span>
          <div>
            <Badge variant="blue">Operations Manager</Badge>
          </div>
        </div>

        <Separator />

        <div className="grid gap-5 sm:grid-cols-2">
          <SelectField
            label="Timezone"
            defaultValue="europe-london"
            options={[
              { value: "utc", label: "UTC" },
              { value: "europe-london", label: "Europe/London (GMT+1)" },
              { value: "america-new_york", label: "America/New York (GMT-4)" },
              { value: "asia-dubai", label: "Asia/Dubai (GMT+4)" },
              { value: "asia-singapore", label: "Asia/Singapore (GMT+8)" },
            ]}
          />
          <SelectField
            label="Language"
            defaultValue="en"
            options={[
              { value: "en", label: "English" },
              { value: "ar", label: "Arabic" },
              { value: "es", label: "Spanish" },
              { value: "de", label: "German" },
              { value: "fr", label: "French" },
            ]}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function NotificationsTab() {
  return (
    <Card className="glass card-seam">
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-4">
          <span className={sectionLabelClass}>Channels</span>
          <Switch
            defaultChecked
            label="Email"
            description="Receive operational alerts by email."
          />
          <Switch
            defaultChecked
            label="Slack"
            description="Post alerts to your connected Slack workspace."
          />
          <Switch label="SMS" description="Critical alerts via text message." />
        </div>

        <Separator />

        <div className="flex flex-col gap-4">
          <span className={sectionLabelClass}>Alerts</span>
          <Switch
            defaultChecked
            label="Gateway failures"
            description="Notify when a payment gateway stops responding."
          />
          <Switch
            defaultChecked
            label="KYC completed"
            description="Notify when a customer finishes verification."
          />
          <Switch
            defaultChecked
            label="Withdrawal approvals"
            description="Notify when a withdrawal needs manual sign-off."
          />
          <Switch
            defaultChecked
            label="Decline-rate spikes"
            description="Notify when decline rates exceed the threshold."
          />
          <Switch
            label="Webhook delays"
            description="Notify when webhook delivery falls behind."
          />
          <Switch
            label="Weekly digest email"
            description="A Monday summary of the week's operations."
          />
        </div>
      </CardContent>
    </Card>
  );
}

type Integration = {
  name: string;
  description: string;
  connected: boolean;
};

const INTEGRATIONS: Integration[] = [
  { name: "CRM", description: "Sync customer profiles and ownership.", connected: true },
  { name: "Zendesk", description: "Pull support tickets into ops views.", connected: false },
  { name: "MT5", description: "Trading platform accounts and balances.", connected: true },
  { name: "Slack", description: "Route alerts to team channels.", connected: true },
  { name: "Stripe", description: "Card payments and payout reconciliation.", connected: true },
  { name: "KYC Provider", description: "Identity and document verification.", connected: false },
];

function IntegrationsTab() {
  return (
    <Card className="glass card-seam">
      <CardHeader>
        <CardTitle>Integrations</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2">
          {INTEGRATIONS.map((it) => (
            <div
              key={it.name}
              className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium text-foreground">{it.name}</span>
                  <span className="text-xs text-muted">{it.description}</span>
                </div>
                <Badge variant={it.connected ? "green" : "default"}>
                  {it.connected ? "Connected" : "Not connected"}
                </Badge>
              </div>
              <div className="flex justify-end">
                {it.connected ? (
                  <Button variant="secondary" size="sm">
                    Manage
                  </Button>
                ) : (
                  <Button size="sm">Connect</Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

type Session = {
  device: string;
  location: string;
  lastActive: string;
  current: boolean;
};

const SESSIONS: Session[] = [
  {
    device: "MacBook Pro · Chrome",
    location: "London, UK",
    lastActive: "Active now",
    current: true,
  },
  {
    device: "iPhone 15 · Safari",
    location: "Dubai, UAE",
    lastActive: "2 hours ago",
    current: false,
  },
];

function SecurityTab() {
  return (
    <Card className="glass card-seam">
      <CardHeader>
        <CardTitle>Security</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-4">
          <span className={sectionLabelClass}>Authentication</span>
          <Switch
            defaultChecked
            label="Two-factor authentication"
            description="Require a one-time code at sign-in."
          />
          <Switch
            label="Require SSO"
            description="Force sign-in through your identity provider."
          />
          <Switch
            label="IP allowlist"
            description="Restrict access to approved IP ranges."
          />
          <Switch
            label="Session timeout"
            description="Automatically sign out after 30 minutes idle."
          />
        </div>

        <Separator />

        <div className="flex flex-col gap-4">
          <span className={sectionLabelClass}>Sessions</span>
          <div className="flex flex-col gap-2">
            {SESSIONS.map((s) => (
              <div
                key={s.device}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3"
              >
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-foreground">{s.device}</span>
                    {s.current ? <Badge variant="green">This device</Badge> : null}
                  </div>
                  <span className="text-xs text-muted">
                    {s.location} · {s.lastActive}
                  </span>
                </div>
                <Button variant="ghost" size="sm" disabled={s.current}>
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        </div>

        <Separator />

        <div className="flex flex-col gap-3">
          <span className={sectionLabelClass}>Danger zone</span>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent-red/20 bg-accent-red-soft p-4">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium text-foreground">
                Sign out all sessions
              </span>
              <span className="text-xs text-muted">
                Ends every active session, including this one.
              </span>
            </div>
            <Button variant="destructive" size="sm">
              Sign out all sessions
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const [tab, setTab] = useState<TabKey>("profile");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Settings"
        description="Profile, notifications, integrations and security."
        actions={<Button size="sm">Save changes</Button>}
      />

      <div className="flex items-center gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "relative px-3 py-2.5 text-sm font-medium transition-colors",
              tab === t.key ? "text-foreground" : "text-muted hover:text-muted-foreground",
            )}
          >
            {t.label}
            {tab === t.key ? (
              <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent-blue" />
            ) : null}
          </button>
        ))}
      </div>

      {tab === "profile" ? <ProfileTab /> : null}
      {tab === "notifications" ? <NotificationsTab /> : null}
      {tab === "integrations" ? <IntegrationsTab /> : null}
      {tab === "security" ? <SecurityTab /> : null}
    </div>
  );
}
