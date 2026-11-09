import { useId } from "react";
import { X, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface HowToExampleColumn
{
	header: string;
	value: string;
	/** Right-aligned mono (numbers). */
	numeric?: boolean;
	width: string;
}

/**
 * The app's one "how to" pattern (catalog design D5 / 2A): nobody reads
 * instructions, so a task is shown as a few numbered steps, optionally with a
 * picture, right where it's done. Open when there's nothing yet (empty table,
 * no credentials); the screen keeps a "¿Cómo…?" link to reopen it once closed.
 */
export function HowToGuide({
	icon: Icon,
	title,
	steps,
	example,
	footnote,
	onClose,
}: {
	icon: LucideIcon;
	title: string;
	steps: React.ReactNode[];
	example?: HowToExampleColumn[];
	footnote?: React.ReactNode;
	onClose: () => void;
})
{
	const titleId = useId();
	return (
		<section aria-labelledby={titleId} className="relative rounded-lg border border-border bg-card p-4">
			<Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Ocultar guía" className="absolute top-2 right-2">
				<X />
			</Button>
			<h2 id={titleId} className="flex items-center gap-2 pr-8 text-[15px] font-semibold">
				<Icon className="size-4 text-primary" />
				{title}
			</h2>
			<div className={`mt-3 grid gap-4 ${example ? "md:grid-cols-[1fr_auto]" : ""}`}>
				<ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm">
					{steps.map((step, i) => <li key={i}>{step}</li>)}
				</ol>
				{example
					? (
						<div aria-hidden className="grid overflow-hidden rounded-md border border-border font-mono text-xs" style={{ gridTemplateColumns: example.map((c) => c.width).join(" ") }}>
							{example.map((c, i) => (
								<span key={`h-${c.header}`} className={`border-b border-border bg-muted px-2 py-1 font-sans font-semibold ${i > 0 ? "border-l" : ""} ${c.numeric ? "text-right" : ""}`}>{c.header}</span>
							))}
							{example.map((c, i) => (
								<span key={`v-${c.header}`} className={`px-2 py-1 ${i > 0 ? "border-l border-border" : ""} ${c.numeric ? "text-right tabular-nums" : "font-sans"}`}>{c.value}</span>
							))}
						</div>
					)
					: null}
			</div>
			{footnote ? <div className="mt-3 text-xs text-muted-foreground">{footnote}</div> : null}
		</section>
	);
}
