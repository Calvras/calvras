"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";

export interface NumberFlowProps {
  value: number;
  format?: {
    currency?: string;
  };
  className?: string;
}

export function NumberFlow({ value, className }: NumberFlowProps) {
  return (
    <span className={className}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={value}
          initial={{ y: -10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 10, opacity: 0 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
          className="inline-block tabular-nums"
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

export default NumberFlow;
