import { useState } from "react";
import { Copy, CheckCheck } from "lucide-react";
import { cn } from "@/lib/utils";

interface ShadcnSection {
  title: string;
  content: string;
}

interface ShadcnIntegrationViewProps {
  message: string;
}

export function ShadcnIntegrationView({ message }: ShadcnIntegrationViewProps) {
  const [copiedSection, setCopiedSection] = useState<string | null>(null);

  // Parse the message into sections based on the template structure
  const sections: ShadcnSection[] = [];
  
  const sectionTitles = [
    "Project Structure Check",
    "Component Path Analysis",
    "Component Code",
    "Dependencies",
    "Implementation Guidelines",
    "Questions to Consider",
    "Integration Steps"
  ];

  // Split by markdown headers or bold sections
  let remainingText = message;
  
  for (let i = 0; i < sectionTitles.length; i++) {
    const currentTitle = sectionTitles[i]!;
    const nextTitle = sectionTitles[i + 1];
    
    // Try to find this section using various patterns
    const patterns = [
      new RegExp(`\\*\\*${currentTitle}\\*\\*([\\s\\S]*?)(?=\\*\\*${nextTitle || "$"}\\*\\*|$)`, "i"),
      new RegExp(`#+\\s*${currentTitle}([\\s\\S]*?)(?=#+\\s*${nextTitle || "$"}|$)`, "i"),
      new RegExp(`${currentTitle}:?\\s*([\\s\\S]*?)(?=${nextTitle || "$"}|$)`, "i")
    ];
    
    for (const pattern of patterns) {
      const match = message.match(pattern);
      if (match && match[1]?.trim()) {
        sections.push({
          title: currentTitle,
          content: match[1].trim()
        });
        break;
      }
    }
  }

  // If no sections found, treat the whole message as one section
  if (sections.length === 0) {
    sections.push({
      title: "Response",
      content: message
    });
  }

  const copyToClipboard = (text: string, sectionTitle: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSection(sectionTitle);
    setTimeout(() => setCopiedSection(null), 2000);
  };

  const extractCodeBlocks = (content: string): Array<{ type: "text" | "code"; content: string; language?: string }> => {
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    const parts: Array<{ type: "text" | "code"; content: string; language?: string }> = [];
    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(content)) !== null) {
      // Add text before code block
      if (match.index > lastIndex) {
        const textBefore = content.slice(lastIndex, match.index).trim();
        if (textBefore) {
          parts.push({ type: "text", content: textBefore });
        }
      }

      // Add code block
      parts.push({
        type: "code",
        content: match[2]!.trim(),
        language: match[1] || "bash"
      });

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < content.length) {
      const remaining = content.slice(lastIndex).trim();
      if (remaining) {
        parts.push({ type: "text", content: remaining });
      }
    }

    return parts.length > 0 ? parts : [{ type: "text", content }];
  };

  return (
    <div className="space-y-4">
      {sections.map((section, idx) => {
        const parts = extractCodeBlocks(section.content);
        
        return (
          <div
            key={idx}
            className="rounded-lg border border-border/50 bg-card/30 backdrop-blur-sm overflow-hidden"
          >
            {/* Section Header */}
            <div className="flex items-center justify-between px-4 py-3 bg-muted/30 border-b border-border/50">
              <h3 className="font-semibold text-sm text-foreground/90">
                {section.title}
              </h3>
              <button
                onClick={() => copyToClipboard(section.content, section.title)}
                className="p-1.5 rounded hover:bg-background/50 transition-colors"
              >
                {copiedSection === section.title ? (
                  <CheckCheck className="w-4 h-4 text-green-500" />
                ) : (
                  <Copy className="w-4 h-4 text-muted-foreground" />
                )}
              </button>
            </div>

            {/* Section Content */}
            <div className="p-4 space-y-3">
              {parts.map((part, partIdx) => (
                <div key={partIdx}>
                  {part.type === "text" ? (
                    <div className="text-sm text-foreground/80 leading-relaxed whitespace-pre-wrap">
                      {part.content}
                    </div>
                  ) : (
                    <div className="relative group">
                      <div className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => copyToClipboard(part.content, `${section.title}-code`)}
                          className="p-1.5 rounded bg-background/80 hover:bg-background transition-colors"
                        >
                          {copiedSection === `${section.title}-code` ? (
                            <CheckCheck className="w-3.5 h-3.5 text-green-500" />
                          ) : (
                            <Copy className="w-3.5 h-3.5 text-muted-foreground" />
                          )}
                        </button>
                      </div>
                      <pre className="bg-muted/50 rounded-md p-3 overflow-x-auto">
                        <code className={cn("text-xs font-mono", part.language === "bash" && "text-blue-400")}>
                          {part.content}
                        </code>
                      </pre>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
