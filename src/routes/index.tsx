import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { PromptInput } from "@/components/ui/ai-chat-input";
import { AgentWorkflow, CUSTOM_TOOLS, MULTI_ROUND_AGENT_WORKFLOW } from "@/components/ui/ai-agent-response";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "AI Agent Chat | Simple Response Bot" },
      { name: "description", content: "A simple chat experience with animated agent responses." },
      { property: "og:title", content: "AI Agent Chat | Simple Response Bot" },
      { property: "og:description", content: "A simple chat experience with animated agent responses." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  const [messages, setMessages] = useState<{ id: number; text: string }[]>([]);
  const latestMessageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (messages.length === 0) return;
    latestMessageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [messages.length]);

  const handleSubmit = (value: string) => {
    const text = value.trim();
    if (!text) return;
    setMessages((previous) => [...previous, { id: Date.now(), text }]);
  };

  return (
    <main className="chat-page antialiased">
      {messages.length === 0 && (
        <div className="chat-welcome">
          <h1 className="text-2xl font-semibold">Ask anything</h1>
        </div>
      )}
      <div className="chat-history" aria-label="Conversation" aria-live="polite">
        {messages.map((message, index) => (
          <div key={message.id} ref={index === messages.length - 1 ? latestMessageRef : undefined} className="flex scroll-mt-8 flex-col gap-6">
            <div className="flex justify-end">
              <div className="max-w-[88%] break-words rounded-2xl bg-muted px-4 py-2.5 text-sm leading-relaxed text-foreground shadow-xs">
                {message.text}
              </div>
            </div>
            <AgentWorkflow phases={MULTI_ROUND_AGENT_WORKFLOW} tools={CUSTOM_TOOLS} workingLabel="Working..." />
          </div>
        ))}
      </div>
      <div className="chat-composer" data-active={messages.length > 0}>
        <PromptInput onSubmit={handleSubmit} placeholder="Ask anything..." />
      </div>
    </main>
  );
}
