"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Info, AlertTriangle, X } from "lucide-react";

type ToastKind = "success" | "info" | "warning";
type Toast = { id: number; kind: ToastKind; title: string; description?: string };

const ToastContext = createContext<{
  toast: (t: { kind?: ToastKind; title: string; description?: string }) => void;
} | null>(null);

let counter = 0;

const kindMeta: Record<ToastKind, { icon: typeof Info; tone: string }> = {
  success: { icon: CheckCircle2, tone: "text-accent-green" },
  info: { icon: Info, tone: "text-accent-blue" },
  warning: { icon: AlertTriangle, tone: "text-accent-orange" },
};

function ToastItem({ t, onClose }: { t: Toast; onClose: () => void }) {
  const { icon: Icon, tone } = kindMeta[t.kind];
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, scale: 0.96 }}
      transition={{ type: "spring", stiffness: 400, damping: 32 }}
      className="glass card-seam flex items-start gap-3 rounded-xl border border-border p-3.5 shadow-[var(--shadow-pop)]"
    >
      <Icon className={`mt-0.5 size-4 shrink-0 ${tone}`} />
      <div className="flex flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">{t.title}</span>
        {t.description ? (
          <span className="text-xs text-muted-foreground">{t.description}</span>
        ) : null}
      </div>
      <button
        onClick={onClose}
        aria-label="Dismiss"
        className="rounded-md p-0.5 text-muted transition-colors hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </motion.div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const remove = useCallback((id: number) => {
    setToasts((cur) => cur.filter((x) => x.id !== id));
  }, []);

  const toast = useCallback(
    ({ kind = "success", title, description }: { kind?: ToastKind; title: string; description?: string }) => {
      const id = ++counter;
      setToasts((cur) => [...cur, { id, kind, title, description }]);
      setTimeout(() => remove(id), 3800);
    },
    [remove],
  );

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[200] flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2">
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <div key={t.id} className="pointer-events-auto">
              <ToastItem t={t} onClose={() => remove(t.id)} />
            </div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
