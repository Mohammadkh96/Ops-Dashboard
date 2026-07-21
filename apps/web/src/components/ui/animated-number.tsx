"use client";

import { useEffect, useRef } from "react";
import { animate, useInView, useMotionValue } from "framer-motion";

type AnimatedNumberProps = {
  value: number;
  format?: (n: number) => string;
  duration?: number;
  className?: string;
};

/** Count-up number that animates from 0 → value the first time it scrolls into view. */
export function AnimatedNumber({
  value,
  format = (n) => n.toLocaleString(),
  duration = 1.1,
  className,
}: AnimatedNumberProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  const motionValue = useMotionValue(0);

  useEffect(() => {
    if (!inView) return;
    const controls = animate(motionValue, value, {
      duration,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (latest) => {
        if (ref.current) ref.current.textContent = format(latest);
      },
    });
    return () => controls.stop();
  }, [inView, value, duration, format, motionValue]);

  return (
    <span ref={ref} className={className}>
      {format(0)}
    </span>
  );
}
