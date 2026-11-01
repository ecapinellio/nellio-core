import { ClipboardPaste, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface PasteExampleColumn
{
	header: string;
	value: string;
	/** Right-aligned mono (numbers). */
	numeric?: boolean;
	width: string;
}

/**
 * Empty-table guide (catalog design D5 / 2A): nobody reads instructions, so
 * the one thing that matters — paste a column from Excel — is shown as
 * three steps with a picture, right above the empty grid. Each entity
 * supplies its own wording, example row and footnote.
 */
export function PasteGuide({
	title,
	steps,
	example,
	footnote,
	onClose,
}: {
	title: string;
	steps: React.ReactNode[];
	example: PasteExampleColumn[];
	footnote: React.ReactNode;
	onClose: () => void;
})
{
	return (
		<section aria-labelledby="paste-guide-title" className="relative rounded-lg border border-border bg-card p-4">
			<Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Ocultar guía" className="absolute top-2 right-2">
				<X />
			</Button>
			<h2 id="paste-guide-title" className="flex items-center gap-2 text-[15px] font-semibold">
				<ClipboardPaste className="size-4 text-primary" />
				{title}
			</h2>
			<div className="mt-3 grid gap-4 md:grid-cols-[1fr_auto]">
				<ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm">
					{steps.map((step, i) => <li key={i}>{step}</li>)}
				</ol>
				<div aria-hidden className="grid overflow-hidden rounded-md border border-border font-mono text-xs" style={{ gridTemplateColumns: example.map((c) => c.width).join(" ") }}>
					{example.map((c, i) => (
						<span key={`h-${c.header}`} className={`border-b border-border bg-muted px-2 py-1 font-sans font-semibold ${i > 0 ? "border-l" : ""} ${c.numeric ? "text-right" : ""}`}>{c.header}</span>
					))}
					{example.map((c, i) => (
						<span key={`v-${c.header}`} className={`px-2 py-1 ${i > 0 ? "border-l border-border" : ""} ${c.numeric ? "text-right tabular-nums" : "font-sans"}`}>{c.value}</span>
					))}
				</div>
			</div>
			<p className="mt-3 text-xs text-muted-foreground">{footnote}</p>
		</section>
	);
}
