"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TimelineContent } from "@/components/ui/timeline-animation";
import { NumberFlow } from "@/components/ui/number-flow";
import { cn } from "@/lib/utils";
import { Briefcase, CheckCheck, Database, Server, ArrowLeft } from "lucide-react";
import { motion } from "framer-motion";
import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";

const plans = [
  {
    name: "Starter",
    description: "Essential autonomous coding directly on your local Desktop.",
    price: 0,
    yearlyPrice: 0,
    buttonText: "Active Plan",
    buttonVariant: "outline" as const,
    features: [
      { text: "Standard generation speed", icon: <Briefcase size={20} /> },
      { text: "Local Desktop filesystem actions", icon: <Database size={20} /> },
      { text: "Basic multi-engine fallback", icon: <Server size={20} /> },
    ],
    includes: [
      "Starter includes:",
      "Standard generation speed",
      "Local Desktop filesystem actions",
      "Basic multi-engine fallback",
      "Community support",
      "Up to 2 concurrent workspaces",
    ],
  },
  {
    name: "Pro",
    description: "Supercharged intelligence, web search research, and extended memory.",
    price: 9,
    yearlyPrice: 79,
    buttonText: "Upgrade to Pro",
    buttonVariant: "default" as const,
    popular: true,
    features: [
      { text: "Significantly higher inference limits", icon: <Briefcase size={20} /> },
      { text: "Real-time web search & docs research", icon: <Database size={20} /> },
      { text: "Expanded project memory & deep context", icon: <Server size={20} /> },
    ],
    includes: [
      "Everything in Starter, plus:",
      "Significantly higher inference limits",
      "Real-time web search & docs research",
      "Expanded project memory & deep context",
      "Early access to experimental models",
      "Instant multi-engine router priority",
    ],
  },
  {
    name: "Ultra",
    description: "Unrestricted engineering tier for power users and heavy production builds.",
    price: 20,
    yearlyPrice: 179,
    buttonText: "Upgrade to Ultra",
    buttonVariant: "outline" as const,
    features: [
      { text: "10x higher usage limits than Pro", icon: <Briefcase size={20} /> },
      { text: "Maximum reasoning compute allocation", icon: <Database size={20} /> },
      { text: "Unlimited concurrent workspace sessions", icon: <Server size={20} /> },
    ],
    includes: [
      "Everything in Pro, plus:",
      "10x higher usage limits than Pro",
      "Maximum reasoning compute allocation",
      "Unlimited concurrent workspace sessions",
      "Dedicated compute lane & zero queue",
      "Priority 24/7 autonomous support",
    ],
  },
];

const PricingSwitch = ({
  onSwitch,
  className,
}: {
  onSwitch: (value: string) => void;
  className?: string;
}) => {
  const [selected, setSelected] = useState("0");

  const handleSwitch = (value: string) => {
    setSelected(value);
    onSwitch(value);
  };

  return (
    <div className={cn("flex justify-center", className)}>
      <div className="relative z-10 mx-auto flex w-fit rounded-xl bg-neutral-900 border border-neutral-800 p-1">
        <button
          onClick={() => handleSwitch("0")}
          type="button"
          className={cn(
            "relative z-10 w-fit cursor-pointer h-12 rounded-xl sm:px-6 px-3 sm:py-2 py-1 font-medium transition-colors sm:text-base text-sm",
            selected === "0"
              ? "text-white"
              : "text-muted-foreground hover:text-white",
          )}
        >
          {selected === "0" && (
            <motion.span
              layoutId={"switch"}
              className="absolute top-0 left-0 h-12 w-full rounded-xl border-4 shadow-sm shadow-orange-600 border-orange-600 bg-gradient-to-t from-orange-500 via-orange-400 to-orange-600"
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
            />
          )}
          <span className="relative">Monthly Billing</span>
        </button>

        <button
          onClick={() => handleSwitch("1")}
          type="button"
          className={cn(
            "relative z-10 w-fit cursor-pointer h-12 flex-shrink-0 rounded-xl sm:px-6 px-3 sm:py-2 py-1 font-medium transition-colors sm:text-base text-sm",
            selected === "1"
              ? "text-white"
              : "text-muted-foreground hover:text-white",
          )}
        >
          {selected === "1" && (
            <motion.span
              layoutId={"switch"}
              className="absolute top-0 left-0 h-12 w-full rounded-xl border-4 shadow-sm shadow-orange-600 border-orange-600 bg-gradient-to-t from-orange-500 via-orange-400 to-orange-600"
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
            />
          )}
          <span className="relative flex items-center gap-2">
            Yearly Billing
            <span className="rounded-full bg-orange-950/80 border border-orange-500/40 px-2 py-0.5 text-xs font-semibold text-orange-300">
              Save 20%
            </span>
          </span>
        </button>
      </div>
    </div>
  );
};

export default function PricingSection5() {
  const [isYearly, setIsYearly] = useState(false);
  const pricingRef = useRef<HTMLDivElement>(null);

  const revealVariants = {
    visible: (i: number) => ({
      y: 0,
      opacity: 1,
      filter: "blur(0px)",
      transition: {
        delay: i * 0.3,
        duration: 0.5,
      },
    }),
    hidden: {
      filter: "blur(10px)",
      y: -20,
      opacity: 0,
    },
  };

  const togglePricingPeriod = (value: string) =>
    setIsYearly(Number.parseInt(value) === 1);

  return (
    <div
      className="px-4 pt-12 pb-20 min-h-screen max-w-7xl mx-auto relative text-foreground"
      ref={pricingRef}
    >
      {/* Top back navigation */}
      <div className="mb-8">
        <Link
          to="/"
          className="inline-flex items-center gap-2 rounded-lg border border-border bg-card/60 px-3.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-card transition-colors shadow-xs"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>Back to Calvras</span>
        </Link>
      </div>

      <article className="text-left mb-6 space-y-4 max-w-2xl">
        <TimelineContent
          as="div"
          animationNum={1}
          timelineRef={pricingRef}
          customVariants={revealVariants}
        >
          <PricingSwitch onSwitch={togglePricingPeriod} className="w-fit" />
        </TimelineContent>
      </article>

      <div className="grid md:grid-cols-3 gap-6 py-6 items-stretch">
        {plans.map((plan, index) => (
          <TimelineContent
            key={plan.name}
            as="div"
            animationNum={2 + index}
            timelineRef={pricingRef}
            customVariants={revealVariants}
          >
            <Card
              className={cn(
                "relative h-full flex flex-col justify-between border rounded-2xl transition-all",
                plan.popular
                  ? "ring-2 ring-orange-500 bg-[#16120e] border-orange-500/40 shadow-xl shadow-orange-500/10"
                  : "bg-[#141416] border-white/10"
              )}
            >
              <CardHeader className="text-left p-6">
                <div className="flex justify-between items-start">
                  <h3 className="xl:text-3xl md:text-2xl text-3xl font-semibold text-white mb-2">
                    {plan.name} Plan
                  </h3>
                  {plan.popular && (
                    <div>
                      <span className="bg-orange-500 text-white px-3 py-1 rounded-full text-xs font-semibold shadow-sm">
                        Popular
                      </span>
                    </div>
                  )}
                </div>
                <p className="xl:text-sm md:text-xs text-sm text-neutral-400 mb-4 leading-relaxed">
                  {plan.description}
                </p>
                <div className="flex items-baseline">
                  <span className="text-4xl font-semibold text-white">
                    $
                    <NumberFlow
                      format={{ currency: "USD" }}
                      value={isYearly ? plan.yearlyPrice : plan.price}
                      className="text-4xl font-semibold"
                    />
                  </span>
                  <span className="text-neutral-400 ml-1 text-sm">
                    /{isYearly ? "year" : "month"}
                  </span>
                </div>
              </CardHeader>

              <CardContent className="p-6 pt-0 flex-1 flex flex-col justify-between">
                <div>
                  <button
                    type="button"
                    onClick={() => {
                      if (plan.price > 0) {
                        alert(`Checkout placeholder: Upgrading to Calvras ${plan.name} ($${isYearly ? plan.yearlyPrice + '/yr' : plan.price + '/mo'})`);
                      }
                    }}
                    className={cn(
                      "w-full mb-6 p-3.5 text-base font-semibold rounded-xl transition-all cursor-pointer",
                      plan.popular
                        ? "bg-gradient-to-t from-orange-600 to-orange-500 hover:from-orange-500 hover:to-orange-400 shadow-lg shadow-orange-600/30 border border-orange-400 text-white active:scale-[0.98]"
                        : plan.buttonVariant === "outline"
                          ? "bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-white active:scale-[0.98]"
                          : "bg-white text-black hover:bg-neutral-200 active:scale-[0.98]"
                    )}
                  >
                    {plan.buttonText}
                  </button>

                  <div className="space-y-3 pt-4 border-t border-white/10">
                    <h2 className="text-xs font-bold uppercase tracking-wider text-neutral-400 mb-3">
                      Features
                    </h2>
                    <h4 className="font-semibold text-sm text-white mb-3">
                      {plan.includes[0]}
                    </h4>
                    <ul className="space-y-2.5">
                      {plan.includes.slice(1).map((feature, featureIndex) => (
                        <li key={featureIndex} className="flex items-center text-sm text-neutral-300">
                          <span className="h-5 w-5 bg-orange-500/10 border border-orange-500/50 rounded-full grid place-content-center shrink-0 mr-3">
                            <CheckCheck className="h-3 w-3 text-orange-400" />
                          </span>
                          <span>{feature}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TimelineContent>
        ))}
      </div>
    </div>
  );
}
export { PricingSection5 };
