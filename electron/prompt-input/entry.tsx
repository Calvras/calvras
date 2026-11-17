import * as React from "react";
import { createRoot } from "react-dom/client";
import { PromptInput } from "../../src/components/ui/ai-chat-input";
import "./prompt-input.css";

type Slot = "home" | "capsule";

interface PromptBridge {
  mount: HTMLElement;
  getValue: () => string;
  setValue: (v: string) => void;
  focus: () => void;
  blur: () => void;
  textarea: () => HTMLTextAreaElement | null;
  onChange?: (v: string) => void;
  onSubmit?: (v: string, meta: { model: string; effort: string; attachments: File[] }) => void;
  onToggle?: (expanded: boolean) => void;
}

const bridges: Partial<Record<Slot, PromptBridge>> = {};

(window as any).CalvrasPrompt = {
  get: (slot: Slot) => bridges[slot],
};

function PromptMount({ slot }: { slot: Slot }) {
  const [value, setValue] = React.useState("");
  const valueRef = React.useRef(value);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const mountRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const bridge: PromptBridge = {
      mount,
      getValue: () => valueRef.current,
      setValue: (v) => {
        valueRef.current = v;
        setValue(v);
      },
      focus: () => wrapRef.current?.querySelector("textarea")?.focus(),
      blur: () => wrapRef.current?.querySelector("textarea")?.blur(),
      textarea: () => wrapRef.current?.querySelector("textarea") ?? null,
    };
    bridges[slot] = bridge;
    window.dispatchEvent(new CustomEvent("calvras-prompt-ready", { detail: { slot } }));
    return () => {
      delete bridges[slot];
    };
  }, [slot]);

  React.useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    let last: boolean | null = null;
    const observer = new MutationObserver(() => {
      const expanded = node.style.maxWidth === "480px";
      if (expanded !== last) {
        last = expanded;
        bridges[slot]?.onToggle?.(expanded);
      }
    });
    observer.observe(node, { attributes: true, attributeFilter: ["style"] });
    return () => observer.disconnect();
  }, [slot]);

  return (
    <div ref={mountRef} className="react-prompt-mount-point">
      <PromptInput
        ref={wrapRef}
        value={value}
        onChange={(v) => {
          valueRef.current = v;
          setValue(v);
          bridges[slot]?.onChange?.(v);
        }}
        onSubmit={(v, meta) => bridges[slot]?.onSubmit?.(v, meta)}
        placeholder="Build something…"
      />
    </div>
  );
}

for (const slot of ["home", "capsule"] as Slot[]) {
  const host = document.getElementById(slot === "home" ? "home-react-prompt" : "capsule-react-prompt");
  if (host) createRoot(host).render(<PromptMount slot={slot} />);
}