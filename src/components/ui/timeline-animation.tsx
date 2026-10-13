"use client";

import * as React from "react";
import { motion, type Variants } from "framer-motion";
import { cn } from "@/lib/utils";

export interface TimelineContentProps extends React.HTMLAttributes<HTMLElement> {
  as?: "div" | "p" | "span" | "article" | "section" | "h1" | "h2" | "h3" | string;
  animationNum?: number;
  timelineRef?: React.RefObject<HTMLDivElement | null>;
  customVariants?: Variants;
  children: React.ReactNode;
  className?: string;
}

export function TimelineContent({
  as = "div",
  animationNum = 0,
  timelineRef,
  customVariants,
  children,
  className,
  ...props
}: TimelineContentProps) {
  const Component = (motion as any)[as] || motion.div;

  return (
    <Component
      custom={animationNum}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.1 }}
      variants={customVariants}
      className={cn(className)}
      {...props}
    >
      {children}
    </Component>
  );
}

export default TimelineContent;
