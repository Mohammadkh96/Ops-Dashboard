"use client";

import { useState } from "react";
import {
  KeyRound,
  Lock,
  Eye,
  EyeOff,
  Copy,
  Plus,
  Trash2,
  Check,
  Plug,
} from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import { StatTileRow, type Stat } from "@/components/ui/stat-tile";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

type Scope = "Read" | "Read/Write" | "Admin";

type ApiKey = {
  id: string;
  name: string;
  token: string;
  scope: Scope;
  created: string;
  lastUsed: string;
  revoked?: boolean;
};

const SCOPE_VARIANT: Record<Scope, "blue" | "purple" | "red"> = {
  Read: "blue",
  "Read/Write": "purple",
  Admin: "red",
};

// Static seeds (fixed strings so SSR/hydration match; new keys are generated client-side).
const SEED_KEYS: ApiKey[] = [
  { id: "k_live_1", name: "Production dashboard", token: "opsk_9f2c4b7ae1d84520bc31a7f0e6d29341", scope: "Read/Write", created: "Jul 12, 2026", lastUsed: "2m ago" },
  { id: "k_live_2", name: "Reporting pipeline", token: "opsk_3a71e8004cf94db2b8e5127acd0f6b229", scope: "Read", created: "Jun 28, 2026", lastUsed: "1h ago" },
  { id: "k_live_3", name: "Reconciliation bot", token: "opsk_5e9017d3ab6f4c1e9d2385f7c40b1188", scope: "Admin", created: "May 03, 2026", lastUsed: "3d ago" },
];

type ServiceCred = {
  name: string;
  description: string;
  connected: boolean;
  masked: string;
};

const SEED_SERVICES: ServiceCred[] = [
  { name: "Stripe", description: "Card payments & payout reconciliation", connected: true, masked: "sk_live_••••••••••••4821" },
  { name: "ForumPay", description: "Crypto payment gateway", connected: false, masked: "" },
  { name: "MT5 Manager API", description: "Trading platform accounts & balances", connected: true, masked: "mt5_••••••••••••7d0a" },
  { name: "CRM", description: "Customer profiles & ownership", connected: true, masked: "crm_••••••••••••11c4" },
  { name: "Zendesk", description: "Support tickets into ops views", connected: false, masked: "" },
  { name: "Slack", description: "Route alerts to team channels", connected: true, masked: "xoxb-••••••••••••93f2" },
  { name: "KYC Provider", description: "Identity & document verification", connected: false, masked: "" },
];

function maskToken(token: string) {
  const tail = token.slice(-4);
  return `opsk_${"•".repeat(20)}${tail}`;
}

function generateToken() {
  const bytes = new Uint8Array(24);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `opsk_${hex}`;
}

export default function ApiKeysPage() {
  const { toast } = useToast();
  const [keys, setKeys] = useState<ApiKey[]>(SEED_KEYS);
  const [services, setServices] = useState<ServiceCred[]>(SEED_SERVICES);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [newlyCreated, setNewlyCreated] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const activeKeys = keys.filter((k) => !k.revoked).length;
  const connectedServices = services.filter((s) => s.connected).length;

  const stats: Stat[] = [
    { label: "Active keys", value: String(activeKeys), tone: "blue" },
    { label: "Services connected", value: `${connectedServices} / ${services.length}`, tone: "green" },
    { label: "Last rotated", value: "2d", tone: "purple" },
    { label: "Failed auth (24h)", value: "0", tone: "orange" },
  ];

  const copy = (value: string, label: string) => {
    navigator.clipboard?.writeText(value);
    toast({ kind: "info", title: `${label} copied`, description: "Store it somewhere safe." });
  };

  const generate = () => {
    const token = generateToken();
    const id = `k_live_${token.slice(-6)}`;
    const key: ApiKey = {
      id,
      name: "New API key",
      token,
      scope: "Read/Write",
      created: "just now",
      lastUsed: "never",
    };
    setKeys((prev) => [key, ...prev]);
    setRevealed((prev) => ({ ...prev, [id]: true }));
    setNewlyCreated(id);
    toast({ title: "API key generated", description: "Copy it now — it won't be shown in full again." });
  };

  const revoke = (id: string) => {
    setKeys((prev) => prev.map((k) => (k.id === id ? { ...k, revoked: true } : k)));
    if (newlyCreated === id) setNewlyCreated(null);
    toast({ kind: "info", title: "Key revoked", description: "Any client using it will stop working." });
  };

  const saveService = (name: string) => {
    const draft = drafts[name]?.trim();
    if (!draft) return;
    setServices((prev) =>
      prev.map((s) =>
        s.name === name ? { ...s, connected: true, masked: `${draft.slice(0, 8)}${"•".repeat(12)}${draft.slice(-4)}` } : s,
      ),
    );
    setDrafts((prev) => ({ ...prev, [name]: "" }));
    toast({ title: `${name} connected`, description: "Credential saved and encrypted." });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="API Keys"
        description="Issue platform keys and store credentials for connected services."
        actions={
          <Button size="sm" onClick={generate}>
            <Plus className="size-4" /> Generate key
          </Button>
        }
      />

      {/* Admin-only notice */}
      <div className="flex items-start gap-3 rounded-xl border border-accent-orange/20 bg-accent-orange-soft px-4 py-3">
        <Lock className="mt-0.5 size-4 shrink-0 text-accent-orange" />
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">Admin only</span>
          <span className="text-xs text-muted-foreground">
            Secrets are encrypted at rest and shown in full only once, at creation. Rotate keys
            regularly and revoke any you no longer recognise.
          </span>
        </div>
      </div>

      <StatTileRow stats={stats} />

      {/* Platform keys */}
      <Card className="glass card-seam">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>
            <span className="flex items-center gap-2">
              <KeyRound className="size-4 text-accent-blue" />
              Platform API keys
            </span>
          </CardTitle>
          <span className="text-xs text-muted">{activeKeys} active</span>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {keys.map((k) => {
            const show = revealed[k.id];
            const display = k.revoked ? "revoked" : show ? k.token : maskToken(k.token);
            return (
              <div
                key={k.id}
                className={cn(
                  "flex flex-col gap-3 rounded-lg border border-border bg-card p-4 transition-opacity",
                  k.revoked && "opacity-60",
                  newlyCreated === k.id && "ring-1 ring-accent-blue/40",
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <span className="text-sm font-medium">{k.name}</span>
                    <Badge variant={SCOPE_VARIANT[k.scope]}>{k.scope}</Badge>
                    {k.revoked ? <Badge variant="red">Revoked</Badge> : <Badge variant="green">Active</Badge>}
                  </div>
                  <span className="text-xs text-muted">
                    Created {k.created} · last used {k.lastUsed}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <code
                    className={cn(
                      "flex-1 truncate rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs",
                      k.revoked ? "text-muted line-through" : "text-muted-foreground",
                    )}
                  >
                    {display}
                  </code>
                  {!k.revoked ? (
                    <>
                      <button
                        type="button"
                        aria-label={show ? "Hide key" : "Reveal key"}
                        onClick={() => setRevealed((p) => ({ ...p, [k.id]: !p[k.id] }))}
                        className="flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-card-hover"
                      >
                        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </button>
                      <button
                        type="button"
                        aria-label="Copy key"
                        onClick={() => copy(k.token, "API key")}
                        className="flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-card-hover"
                      >
                        <Copy className="size-4" />
                      </button>
                      <button
                        type="button"
                        aria-label="Revoke key"
                        onClick={() => revoke(k.id)}
                        className="flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:border-accent-red/30 hover:bg-accent-red-soft hover:text-accent-red"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </>
                  ) : null}
                </div>

                {newlyCreated === k.id ? (
                  <span className="flex items-center gap-1.5 text-xs text-accent-blue">
                    <Check className="size-3.5" /> Copy this key now — it won&apos;t be shown in full again.
                  </span>
                ) : null}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Service credentials */}
      <Card className="glass card-seam">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>
            <span className="flex items-center gap-2">
              <Plug className="size-4 text-accent-blue" />
              Service credentials
            </span>
          </CardTitle>
          <span className="text-xs text-muted">{connectedServices} connected</span>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {services.map((s) => (
            <div key={s.name} className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{s.name}</span>
                  <span className="text-xs text-muted">{s.description}</span>
                </div>
                <Badge variant={s.connected ? "green" : "default"}>
                  {s.connected ? "Connected" : "Not connected"}
                </Badge>
              </div>

              {s.connected ? (
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-muted-foreground">
                    {s.masked}
                  </code>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setServices((prev) => prev.map((x) => (x.name === s.name ? { ...x, connected: false, masked: "" } : x)))}
                  >
                    Rotate
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    value={drafts[s.name] ?? ""}
                    onChange={(e) => setDrafts((p) => ({ ...p, [s.name]: e.target.value }))}
                    placeholder={`Paste ${s.name} API key…`}
                    className="h-9 flex-1 rounded-lg border border-border bg-surface px-3 font-mono text-xs outline-none transition-colors placeholder:font-sans placeholder:text-muted focus:border-border-strong"
                  />
                  <Button size="sm" onClick={() => saveService(s.name)} disabled={!drafts[s.name]?.trim()}>
                    Connect
                  </Button>
                </div>
              )}
            </div>
          ))}

          <Separator />
          <p className="text-xs text-muted">
            Keys are transmitted over TLS and stored encrypted. This demo keeps them in-memory only —
            nothing is persisted or sent anywhere.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
