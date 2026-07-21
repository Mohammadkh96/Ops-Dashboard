"use client";

import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";

export function Drawer({
  open,
  onOpenChange,
  title,
  subtitle,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          className="fixed inset-y-0 right-0 z-[100] flex w-full max-w-md flex-col border-l border-border bg-surface shadow-[var(--shadow-pop)] outline-none data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=open]:duration-300"
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="flex flex-col gap-0.5">
              <Dialog.Title className="text-base font-semibold tracking-tight">{title}</Dialog.Title>
              {subtitle ? (
                <Dialog.Description className="text-xs text-muted">{subtitle}</Dialog.Description>
              ) : null}
            </div>
            <Dialog.Close className="rounded-lg p-1.5 text-muted transition-colors hover:bg-card hover:text-foreground">
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
          {footer ? <div className="border-t border-border px-5 py-4">{footer}</div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
