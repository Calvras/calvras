import { Puzzle, Search } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";

export function PluginsPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-md rounded-2xl bg-card">
      <DialogTitle className="flex items-center gap-2 text-xl"><Puzzle size={20} /> Customize Calvras</DialogTitle>
      <DialogDescription>Bring your tools into your workspace.</DialogDescription>
      <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm text-muted-foreground"><Search size={16} /><span>Plugins</span></div>
      <p className="mt-3 text-xs font-medium uppercase tracking-widest text-muted-foreground">Installed</p>
      <div className="rounded-xl border border-dashed px-6 py-10 text-center"><Puzzle className="mx-auto mb-3 text-muted-foreground" size={28} /><p className="text-sm">Your workspace, connected.</p><p className="mt-2 text-xs leading-5 text-muted-foreground">No plugins installed. Plugin connections will appear here when they’re available.</p></div>
    </DialogContent>
  </Dialog>;
}
