"use client";

import type { ReactNode } from "react";
import { motion } from "framer-motion";

import { fadeUp } from "@/lib/motion";

/** Fades + rises its child into view once, on scroll. */
export function Reveal({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      variants={fadeUp}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: "-60px" }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
