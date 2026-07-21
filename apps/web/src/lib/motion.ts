import type { Variants, Transition } from "framer-motion";

export const easeOut: Transition["ease"] = [0.22, 1, 0.36, 1];

/** Container that staggers its children into view. */
export const staggerContainer: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.05, delayChildren: 0.04 },
  },
};

/** Child item — fades and rises into place. */
export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.45, ease: easeOut },
  },
};

/** Subtle scale-in for cards/tiles. */
export const fadeScale: Variants = {
  hidden: { opacity: 0, scale: 0.98 },
  show: {
    opacity: 1,
    scale: 1,
    transition: { duration: 0.4, ease: easeOut },
  },
};
