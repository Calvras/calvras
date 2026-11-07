import { motion, type Variants } from "framer-motion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Marquee } from "@/components/ui/marquee";
import {
  Wrench, TrendingUp, Megaphone, User, Building2, ClipboardList,
  Code2, Palette, Layers, Rocket, Package, CircleCheck,
  ImageIcon, ImagePlay, Lightbulb, Plus, Mic, Paperclip,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

type Tag = { icon: LucideIcon; label: string };

const row1Tags: Tag[] = [
  { icon: Wrench, label: "Engineers" },
  { icon: TrendingUp, label: "Sales" },
  { icon: Megaphone, label: "Marketing" },
  { icon: User, label: "HR" },
  { icon: Building2, label: "Enterprises" },
];

const row2Tags: Tag[] = [
  { icon: ClipboardList, label: "Project Managers" },
  { icon: Code2, label: "Developers" },
  { icon: Palette, label: "Designers" },
  { icon: Layers, label: "Product Team" },
];

const row3Tags: Tag[] = [
  { icon: Rocket, label: "Founders" },
  { icon: Package, label: "Product Team" },
  { icon: Building2, label: "Enterprises" },
  { icon: Wrench, label: "Engineers" },
];

const TagChip = ({ icon: Icon, label }: Tag) => (
  <div className="flex items-center gap-1.5 h-10 px-4 rounded-full bg-black/10 border border-white/20 shrink-0">
    <Icon className="size-4 text-white" />
    <span className="text-sm font-medium text-white whitespace-nowrap">{label}</span>
  </div>
);

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: "easeOut" } },
};

const fadeLeft: Variants = {
  hidden: { opacity: 0, x: -30 },
  show: { opacity: 1, x: 0, transition: { duration: 0.6, ease: "easeOut" } },
};

const fadeRight: Variants = {
  hidden: { opacity: 0, x: 30 },
  show: { opacity: 1, x: 0, transition: { duration: 0.6, ease: "easeOut" } },
};

const stagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.1, delayChildren: 0.05 } },
};

const Feature = () => {
  return (
    <section>
      <div className="max-w-7xl xl:px-16 lg:px-8 px-4 lg:py-20 sm:py-16 py-10 mx-auto w-full">
        <div className="flex flex-col gap-5">
          {/* Header */}
          <motion.div
            className="flex flex-col items-center gap-4 text-center mb-7"
            initial="hidden"
            whileInView="show"
            viewport={{once: true, amount: 0.3}}
            variants={stagger}
          >
            <motion.div variants={fadeUp}>
              <Badge variant="outline" className="text-sm font-normal text-foreground px-3 py-1 rounded-full h-auto">
                Capabilities
              </Badge>
            </motion.div>
            <motion.h2 variants={fadeUp} className="xl:text-4xl text-3xl font-medium text-foreground max-w-2xl leading-tight">
              Discover AI chatbot capabilities
            </motion.h2>
            <motion.p variants={fadeUp} className="text-base lg:text-xl text-muted-foreground max-w-2xl">
              Accelerate your workflows with AI-powered tools designed for speed, clarity, and scalability—built to support teams at every stage.
            </motion.p>
          </motion.div>

          {/* Row 1 */}
          <div className="bg-muted rounded-3xl p-2 flex flex-col md:flex-row gap-0 overflow-hidden">
            <motion.div
              className="relative rounded-2xl overflow-hidden md:w-1/2 h-72 md:h-auto min-h-[300px] shrink-0"
              initial="hidden"
              whileInView="show"
              viewport={{once: true, amount: 0.2}}
              variants={fadeLeft}
            >
              <img
                src="https://images.unsplash.com/photo-1485827404703-89b55fcc595e?w=800&q=80"
                alt="AI workflow automation"
                className="absolute inset-0 w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-foreground/20" />
              <div className="absolute inset-0 flex flex-col justify-center gap-4 py-10">
                <Marquee className="[--duration:20s] [--gap:0.75rem] p-0">
                  {row1Tags.map((tag, i) => <TagChip key={i} {...tag} />)}
                </Marquee>
                <Marquee reverse className="[--duration:16s] [--gap:0.75rem] p-0">
                  {row2Tags.map((tag, i) => <TagChip key={i} {...tag} />)}
                </Marquee>
                <Marquee className="[--duration:22s] [--gap:0.75rem] p-0">
                  {row3Tags.map((tag, i) => <TagChip key={i} {...tag} />)}
                </Marquee>
              </div>
            </motion.div>
            <motion.div
              className="flex-1 flex flex-col justify-center gap-8 p-8 md:p-10"
              initial="hidden"
              whileInView="show"
              viewport={{once: true, amount: 0.2}}
              variants={stagger}
            >
              <motion.div variants={fadeRight} className="flex flex-col gap-3">
                <h3 className="text-2xl font-medium text-foreground leading-snug">
                  Automate complex workflows easily with AI-powered solutions
                </h3>
                <p className="text-base text-muted-foreground">
                  Simplify operations by automating repetitive and time-consuming processes with intelligent AI designed for efficiency and accuracy.
                </p>
              </motion.div>
              <motion.div variants={stagger} className="flex flex-col gap-3">
                {[
                  { title: "Smart Automation", body: "Execute tasks automatically with minimal manual input, reducing repetitive work and freeing up time for high-impact activities." },
                  { title: "Process Optimization", body: "Improve speed and consistency across workflows, streamlining operations for more reliable and efficient outcomes." },
                ].map(({ title, body }, i) => (
                  <motion.div key={i} variants={fadeRight} className="flex gap-3 items-start">
                    <CircleCheck className="size-5 text-foreground shrink-0 mt-0.5" />
                    <p className="text-base text-muted-foreground">
                      <span className="font-medium text-foreground">{title}: </span>{body}
                    </p>
                  </motion.div>
                ))}
              </motion.div>
            </motion.div>
          </div>

          {/* Row 2 */}
          <div className="bg-muted rounded-3xl p-2 flex flex-col md:flex-row gap-0 overflow-hidden">
            <motion.div
              className="flex-1 flex flex-col justify-center gap-8 p-8 md:p-10"
              initial="hidden"
              whileInView="show"
              viewport={{once: true, amount: 0.2}}
              variants={stagger}
            >
              <motion.div variants={fadeLeft} className="flex flex-col gap-4">
                <div className="flex flex-col gap-3">
                  <h3 className="text-2xl font-medium text-foreground leading-snug">
                    Seamlessly integrate AI tools with your workflow systems
                  </h3>
                  <p className="text-base text-muted-foreground">
                    Interact with AI in real time to generate content, automate responses, and streamline tasks through a simple interface.
                  </p>
                </div>
              </motion.div>
              <motion.div variants={stagger} className="flex flex-col gap-3">
                {[
                  { title: "AI-Powered Assistance", body: "Generate responses, ideas, and content instantly with intelligent, context-aware AI support, helping you work faster and make more informed decisions." },
                  { title: "Interactive Experience", body: "Engage with a dynamic and intuitive interface that makes creating, refining, and managing outputs effortless, giving you control over your workflow." },
                ].map(({ title, body }, i) => (
                  <motion.div key={i} variants={fadeLeft} className="flex gap-3 items-start">
                    <CircleCheck className="size-5 text-foreground shrink-0 mt-0.5" />
                    <p className="text-base text-muted-foreground">
                      <span className="font-medium text-foreground">{title}: </span>{body}
                    </p>
                  </motion.div>
                ))}
              </motion.div>
            </motion.div>
            <motion.div
              className="relative rounded-2xl overflow-hidden md:w-1/2 h-72 md:h-auto min-h-[300px] shrink-0"
              initial="hidden"
              whileInView="show"
              viewport={{once: true, amount: 0.2}}
              variants={fadeRight}
            >
              <img
                src="https://images.unsplash.com/photo-1677442135703-1787eea5ce01?w=800&q=80"
                alt="AI chat interface"
                className="absolute inset-0 w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-foreground/20" />
              <div className="absolute inset-0 flex items-center justify-center px-6">
                <div className="w-full max-w-md bg-gray-950/20 px-2 py-2.5 sm:p-4 rounded-3xl flex flex-col gap-3">
                  <div className="flex flex-wrap justify-center items-center gap-1">
                    <Button className="text-xs bg-white/20 border border-gray-200/40 h-auto px-2 xl:px-4 py-1.5 xl:py-2 rounded-full text-white cursor-pointer">
                      <ImageIcon /><span>Create Image</span>
                    </Button>
                    <Button className="text-xs bg-white/20 border border-gray-200/40 h-auto px-2 xl:px-4 py-1.5 xl:py-2 rounded-full text-white cursor-pointer">
                      <ImagePlay /><span>Generate Video</span>
                    </Button>
                    <Button className="text-xs bg-white/20 border border-gray-200/40 h-auto px-2 xl:px-4 py-1.5 xl:py-2 rounded-full text-white cursor-pointer">
                      <Lightbulb /><span>Deep Search</span>
                    </Button>
                  </div>
                  <div className="flex items-center gap-0 sm:gap-2 rounded-full border border-white/20 bg-white/10 px-1.5 sm:px-3 py-1.5 sm:py-2 shadow-sm">
                    <Button size="icon" variant="ghost" className="rounded-full h-8 w-8 hover:bg-muted/10 cursor-pointer">
                      <Plus className="h-4 w-4 text-white" />
                    </Button>
                    <Input
                      placeholder="What would you like to design today?"
                      className="border-none bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 text-white p-0 placeholder:text-white"
                    />
                    <div className="flex items-center gap-1">
                      <Button size="icon" variant="ghost" className="rounded-full h-8 w-8 hover:bg-muted/10 cursor-pointer">
                        <Mic className="h-4 w-4 text-white" />
                      </Button>
                      <Button size="icon" variant="ghost" className="rounded-full h-8 w-8 hover:bg-muted/10 cursor-pointer">
                        <Paperclip className="h-4 w-4 text-white" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Feature;
