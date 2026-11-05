"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ClipboardPaste, Loader2, Search } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { listMovements, parseCountPaste, parseQuantity, type Movement, type MovementKind, type StockRow } from "@/lib/inventory/stock";
import { normalizeName } from "@/lib/grid/core";
import { isProductUnit, UNIT_LABELS } from "@/lib/products/units";
import { formatOrderTimestamp } from "@/lib/format";
import { cn } from "@/lib/utils";
import { saveStock } from "@/app/(app)/inventory/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FormPanel, FormPanelFooter, FormPanelHeader } from "@/components/form-panel";

const qty = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const unitLabel = (u: string | null) => (isProductUnit(u) ? UNIT_LABELS[u] : "");

const KIND_LABELS: Record<MovementKind, string> = {
	receipt: "Entrada",
	count: "Conteo físico",
	order: "Pedido",
};

/**
 * /inventory: stock per product (sum of its movements). Everyone with access
 * reads it and each product's history; only an admin records receipts and
 * counts — one at a time in the panel, or a whole count pasted from Excel.
 */
export function InventoryManager({ rows, canEdit }: { rows: StockRow[]; canEdit: boolean })
{
	const [search, setSearch] = useState("");
	const [openId, setOpenId] = useState<string | null>(null);
	const [pasteOpen, setPasteOpen] = useState(false);

	// Inactive products only while they still hold (or owe) stock.
	const visible = useMemo(() =>
	{
		const needle = normalizeName(search);
		return rows.filter((r) => (r.active || r.stock !== 0) && normalizeName(r.name).includes(needle));
	}, [rows, search]);
	const negatives = rows.filter((r) => r.stock < 0).length;
	const open = rows.find((r) => r.id === openId) ?? null;

	return (
		<div className="flex max-w-[1280px] flex-col gap-4">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h1 className="text-xl font-semibold tracking-tight">Inventario</h1>
					<p className="text-sm text-muted-foreground">Lo que hay en bodega. Baja cuando un pedido sale y sube con lo que regresa.</p>
				</div>
				{canEdit
					? (
						<Button variant="secondary" onClick={() => setPasteOpen(true)}>
							<ClipboardPaste />Pegar conteo
						</Button>
					)
					: null}
			</div>

			<div className="flex flex-wrap items-center gap-3">
				<div className="relative w-full max-w-72">
					<Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar producto" className="pl-8" aria-label="Buscar producto" />
				</div>
				{negatives > 0
					? (
						<p className="flex items-center gap-1.5 text-sm font-medium text-destructive">
							<AlertTriangle className="size-4" />
							{negatives === 1 ? "1 producto en negativo" : `${negatives} productos en negativo`}: falta contar o registrar una entrada.
						</p>
					)
					: null}
			</div>

			{rows.length === 0
				? <p className="text-sm text-muted-foreground">Todavía no hay productos. Agrégalos en Productos.</p>
				: (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Producto</TableHead>
								<TableHead className="text-right">En bodega</TableHead>
								<TableHead className="hidden sm:table-cell">Unidad</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{visible.map((r) => (
								<TableRow key={r.id} className={cn("cursor-pointer", !r.active && "text-muted-foreground")} onClick={() => setOpenId(r.id)}>
									<TableCell className="font-medium">
										<button type="button" className="text-left hover:underline" onClick={() => setOpenId(r.id)}>
											{r.name}
										</button>
										{r.active ? null : <span className="font-normal"> (inactivo)</span>}
									</TableCell>
									<TableCell className={cn("text-right font-mono tabular-nums", r.stock < 0 && "font-semibold text-destructive")}>
										{qty(r.stock)}
										<span className="font-sans text-xs text-muted-foreground sm:hidden"> {unitLabel(r.unit)}</span>
									</TableCell>
									<TableCell className="hidden text-muted-foreground sm:table-cell">{unitLabel(r.unit)}</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}

			<FormPanel open={open !== null} onOpenChange={(o) => { if (!o) setOpenId(null); }}>
				{open ? <ProductStock key={open.id} row={open} canEdit={canEdit} /> : null}
			</FormPanel>

			{canEdit
				? (
					<FormPanel open={pasteOpen} onOpenChange={setPasteOpen}>
						{pasteOpen ? <CountPaste rows={rows} onDone={() => setPasteOpen(false)} /> : null}
					</FormPanel>
				)
				: null}
		</div>
	);
}

function ProductStock({ row, canEdit }: { row: StockRow; canEdit: boolean })
{
	const supabase = useMemo(() => createClient(), []);
	const [movements, setMovements] = useState<Movement[] | null>(null);
	const [loadError, setLoadError] = useState(false);
	const [kind, setKind] = useState<"receipt" | "count">("receipt");
	const [amount, setAmount] = useState("");
	const [note, setNote] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Reload the history whenever the stock changes (after a save the page refreshes `row`).
	useEffect(() =>
	{
		let live = true;
		listMovements(supabase, row.id).then(({ data, error: e }) =>
		{
			if (live)
			{
				setMovements(data);
				setLoadError(Boolean(e));
			}
		});
		return () => { live = false; };
	}, [supabase, row.id, row.stock]);

	async function submit(e: React.FormEvent)
	{
		e.preventDefault();
		const value = parseQuantity(amount);
		if (value === null || (kind === "receipt" && value === 0))
		{
			setError(kind === "receipt" ? "Escribe una cantidad mayor que cero." : "Escribe la cantidad contada (puede ser 0).");
			return;
		}
		setSaving(true);
		setError(null);
		const result = await saveStock([{ product_id: row.id, kind, quantity: value, note: note.trim() || undefined }]);
		setSaving(false);
		if (result.error)
		{
			setError(result.error);
			return;
		}
		setAmount("");
		setNote("");
	}

	return (
		<form onSubmit={submit} noValidate className="flex min-h-full flex-col">
			<FormPanelHeader>
				<SheetTitle>{row.name}</SheetTitle>
				<SheetDescription>
					En bodega:{" "}
					<span className={cn("font-mono text-base font-semibold tabular-nums text-foreground", row.stock < 0 && "text-destructive")}>
						{qty(row.stock)}
					</span>{" "}
					{unitLabel(row.unit)}
				</SheetDescription>
			</FormPanelHeader>

			<div className="flex flex-col gap-4 px-4 pb-4">
				{canEdit
					? (
						<fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3">
							<legend className="px-1 text-sm font-semibold">Registrar</legend>
							<div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Tipo">
								{(["receipt", "count"] as const).map((k) => (
									<Button
										key={k}
										type="button"
										role="radio"
										aria-checked={kind === k}
										variant={kind === k ? "default" : "secondary"}
										className="h-11 md:h-9"
										onClick={() => { setKind(k); setError(null); }}
									>
										{KIND_LABELS[k]}
									</Button>
								))}
							</div>
							<p className="text-xs text-muted-foreground">
								{kind === "receipt" ? "Se suma a lo que hay. Ej.: llegaron 20 del proveedor." : "Lo que contaste en bodega. El sistema ajusta la diferencia."}
							</p>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="stock-amount">{kind === "receipt" ? "Cantidad que entró" : "Cantidad contada"}</Label>
								<Input
									id="stock-amount"
									inputMode="decimal"
									value={amount}
									onChange={(e) => setAmount(e.target.value)}
									className="h-11 font-mono tabular-nums md:h-9"
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="stock-note">Nota (opcional)</Label>
								<Input id="stock-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Ej.: factura 1234" className="h-11 md:h-9" />
							</div>
							{error ? <p role="alert" className="text-sm font-medium text-destructive">{error}</p> : null}
							<Button type="submit" className="h-11 md:h-9" disabled={saving}>
								{saving ? <><Loader2 className="animate-spin" />Guardando…</> : "Guardar"}
							</Button>
						</fieldset>
					)
					: null}

				<section className="flex flex-col gap-2">
					<h3 className="text-sm font-semibold">Historial</h3>
					{loadError
						? <p className="text-sm text-destructive">No se pudo cargar el historial.</p>
						: movements === null
							? <p className="text-sm text-muted-foreground">Cargando…</p>
							: movements.length === 0
								? <p className="text-sm text-muted-foreground">Sin movimientos todavía.</p>
								: (
									<ul className="flex flex-col divide-y divide-border rounded-md border border-border">
										{movements.map((m) => (
											<li key={m.id} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
												<div className="min-w-0">
													<p className="font-medium">
														{m.kind === "order" ? (m.quantity < 0 ? "Salió en pedido" : "Regresó de pedido") : KIND_LABELS[m.kind]}
														{m.customer ? <span className="font-normal text-muted-foreground"> · {m.customer}</span> : null}
													</p>
													<p className="font-mono text-xs tabular-nums text-muted-foreground">
														{formatOrderTimestamp(m.created_at)}
														{m.author ? <span className="font-sans"> · {m.author}</span> : null}
													</p>
													{m.note ? <p className="break-words text-xs text-muted-foreground">{m.note}</p> : null}
												</div>
												<span className={cn("font-mono tabular-nums", m.quantity < 0 ? "text-destructive" : "text-[var(--user-active)]")}>
													{m.quantity > 0 ? "+" : "−"}{qty(Math.abs(m.quantity))}
												</span>
											</li>
										))}
									</ul>
								)}
				</section>
			</div>
		</form>
	);
}

function CountPaste({ rows, onDone }: { rows: StockRow[]; onDone: () => void })
{
	const [text, setText] = useState("");
	const [note, setNote] = useState("Conteo físico");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const lines = useMemo(() => parseCountPaste(text, rows), [text, rows]);
	const good = lines.filter((l) => l.ok);
	const bad = lines.filter((l) => !l.ok);

	async function submit(e: React.FormEvent)
	{
		e.preventDefault();
		if (good.length === 0 || bad.length > 0)
		{
			return;
		}
		setSaving(true);
		setError(null);
		const result = await saveStock(good.map((l) => ({ product_id: l.productId, kind: "count" as const, quantity: l.quantity, note: note.trim() || undefined })));
		setSaving(false);
		if (result.error)
		{
			setError(result.error);
			return;
		}
		onDone();
	}

	return (
		<form onSubmit={submit} noValidate className="flex min-h-full flex-col">
			<FormPanelHeader>
				<SheetTitle>Pegar conteo</SheetTitle>
				<SheetDescription>
					Copia de Excel dos columnas: <strong>Producto</strong> y <strong>Cantidad contada</strong>. Cada producto queda con esa cantidad; los que no pegues no cambian.
				</SheetDescription>
			</FormPanelHeader>
			<div className="flex flex-col gap-4 px-4 pb-4">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="count-paste">Datos</Label>
					<Textarea
						id="count-paste"
						data-autofocus
						value={text}
						onChange={(e) => setText(e.target.value)}
						rows={8}
						placeholder={"Cloro 5%\t120\nSoda cáustica\t35.5"}
						className="font-mono text-sm"
					/>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="count-note">Nota</Label>
					<Input id="count-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
				</div>
				{lines.length > 0
					? (
						<p className="text-sm">
							<span className="font-mono tabular-nums">{good.length}</span> productos listos
							{bad.length > 0 ? <>, <span className="font-semibold text-destructive">{bad.length} con problemas</span></> : null}.
						</p>
					)
					: null}
				{bad.length > 0
					? (
						<ul className="flex flex-col gap-1 text-sm">
							{bad.map((l) => !l.ok && (
								<li key={l.line} className="text-destructive">
									Fila {l.line}: {l.reason} — <span className="font-mono">{l.text || "(vacío)"}</span>
								</li>
							))}
						</ul>
					)
					: null}
			</div>
			<FormPanelFooter>
				{error ? <p role="alert" className="text-sm font-medium text-destructive">{error}</p> : null}
				<Button type="submit" className="h-11 md:h-9" disabled={saving || good.length === 0 || bad.length > 0}>
					{saving ? <><Loader2 className="animate-spin" />Guardando…</> : `Guardar ${good.length || ""} conteos`}
				</Button>
			</FormPanelFooter>
		</form>
	);
}
