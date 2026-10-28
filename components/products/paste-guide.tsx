import { ClipboardPaste, X } from "lucide-react";
import { PRODUCT_UNITS, UNIT_LABELS } from "@/lib/products/units";
import { Button } from "@/components/ui/button";

/**
 * Empty-catalog guide (design D5 / 2A): nobody reads instructions, so the
 * one thing that matters — paste a column from Excel — is shown as three
 * steps with a picture, right above the empty grid.
 */
export function PasteGuide({ onClose }: { onClose: () => void })
{
	return (
		<section aria-labelledby="paste-guide-title" className="relative rounded-lg border border-border bg-card p-4">
			<Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Ocultar guía" className="absolute top-2 right-2">
				<X />
			</Button>
			<h2 id="paste-guide-title" className="flex items-center gap-2 text-[15px] font-semibold">
				<ClipboardPaste className="size-4 text-primary" />
				Carga tu catálogo desde Excel
			</h2>
			<div className="mt-3 grid gap-4 md:grid-cols-[1fr_auto]">
				<ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm">
					<li>En Excel, selecciona y copia la columna de <strong>nombres</strong>.</li>
					<li>Haz clic en la primera celda de <strong>Nombre</strong> y pega (Ctrl+V).</li>
					<li>Repite con <strong>Precio</strong> y <strong>Unidad</strong>. También puedes copiar las 3 columnas juntas.</li>
				</ol>
				<div aria-hidden className="grid grid-cols-[7rem_4rem_4.5rem] overflow-hidden rounded-md border border-border font-mono text-xs">
					<span className="border-b border-border bg-muted px-2 py-1 font-sans font-semibold">Nombre</span>
					<span className="border-b border-l border-border bg-muted px-2 py-1 text-right font-sans font-semibold">Precio</span>
					<span className="border-b border-l border-border bg-muted px-2 py-1 font-sans font-semibold">Unidad</span>
					<span className="px-2 py-1 font-sans">Cloro 5%</span>
					<span className="border-l border-border px-2 py-1 text-right tabular-nums">12.50</span>
					<span className="border-l border-border px-2 py-1 font-sans">Galón</span>
				</div>
			</div>
			<p className="mt-3 text-xs text-muted-foreground">
				Unidades válidas: {PRODUCT_UNITS.map((u) => UNIT_LABELS[u]).join(", ")}. Los precios con punto decimal: 1,250.00.
			</p>
		</section>
	);
}
