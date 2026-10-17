"use client";

import { useState } from "react";
import { Check, X } from "lucide-react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { searchProducts, quickAddProduct, updateProductPricing, type ProductUnit } from "@/lib/supabase/queries";
import { calculateLineTotal } from "@/lib/order-math";
import { EntitySearch } from "@/components/capture/entity-search";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// Spanish display labels for the English-stored unit values (slice 1's
// products_unit_check) — same pattern as orders.status: stored in English,
// displayed in Spanish once a UI layer exists to do it. This is that layer.
const UNIT_LABELS: Record<ProductUnit, string> = {
	ton: "Tonelada",
	kg: "Kg",
	lb: "Lb",
	l: "Litro",
	gal: "Galón",
	each: "Unidad",
};
const UNIT_OPTIONS = Object.keys(UNIT_LABELS) as ProductUnit[];

export interface LineItem
{
	productId: string;
	productName: string;
	quantity: number;
	pricePerUnit: number | null;
	unit: ProductUnit | null;
}

interface LineItemsProps
{
	supabase: SupabaseClient<Database>;
	items: LineItem[];
	onAdd: (productId: string, productName: string, pricePerUnit: number | null, unit: ProductUnit | null) => void;
	onQuantityChange: (productId: string, quantity: number) => void;
	onRemove: (productId: string) => void;
	onPriceUpdate: (productId: string, pricePerUnit: number, unit: ProductUnit) => void;
}

export function LineItems({ supabase, items, onAdd, onQuantityChange, onRemove, onPriceUpdate }: LineItemsProps)
{
	// Which line's "+ precio" affordance is expanded — transient UI state,
	// not part of the order itself, so it stays local rather than lifted to
	// CaptureForm alongside the committed items array.
	const [editingProductId, setEditingProductId] = useState<string | null>(null);
	const [editPrice, setEditPrice] = useState("");
	const [editUnit, setEditUnit] = useState<ProductUnit | "">("");
	const [saving, setSaving] = useState(false);

	function startEditing(productId: string)
	{
		setEditingProductId(productId);
		setEditPrice("");
		setEditUnit("");
	}

	function cancelEditing()
	{
		setEditingProductId(null);
	}

	async function savePrice(productId: string)
	{
		const price = Number(editPrice);
		if (!editPrice || price <= 0 || !editUnit || saving)
		{
			return;
		}
		setSaving(true);
		const { error } = await updateProductPricing(supabase, productId, { pricePerUnit: price, unit: editUnit });
		setSaving(false);
		if (error)
		{
			return;
		}
		onPriceUpdate(productId, price, editUnit);
		setEditingProductId(null);
	}

	return (
		<div className="flex flex-col gap-3">
			<Label>Productos {items.length > 0 ? <span className="font-mono text-xs font-normal text-muted-foreground">· {items.length} líneas</span> : null}</Label>

			{items.length > 0
				? (
					<div className="flex flex-col divide-y divide-border rounded-md border border-border">
						{items.map((item) =>
						{
							const subtotal = calculateLineTotal(item.quantity, item.pricePerUnit);
							const isEditing = editingProductId === item.productId;

							return (
								<div key={item.productId} className="flex flex-col gap-2 px-3 py-2">
									<div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3">
										<span className="truncate text-sm font-medium">{item.productName}</span>
										<input
											type="number"
											min="0.01"
											step="0.01"
											value={item.quantity}
											onChange={(e) => onQuantityChange(item.productId, Number(e.target.value))}
											className="w-20 rounded-sm border border-input bg-transparent px-2 py-1 text-right font-mono text-sm tabular-nums outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
										/>
										{subtotal !== null
											? <span className="font-mono text-sm tabular-nums text-muted-foreground">${subtotal.toFixed(2)}</span>
											: (
												<button
													type="button"
													onClick={() => startEditing(item.productId)}
													className="text-xs font-medium text-primary hover:underline"
												>
													+ precio
												</button>
											)}
										<button
											type="button"
											onClick={() => onRemove(item.productId)}
											aria-label={`Quitar ${item.productName}`}
											className="text-muted-foreground hover:text-destructive"
										>
											<X className="size-4" />
										</button>
									</div>

									{isEditing
										? (
											<div className="flex items-center gap-2 rounded-md bg-muted/50 p-2">
												<input
													type="number"
													min="0.01"
													step="0.01"
													placeholder="Precio"
													value={editPrice}
													onChange={(e) => setEditPrice(e.target.value)}
													autoFocus
													className="w-24 rounded-sm border border-input bg-transparent px-2 py-1 text-sm tabular-nums outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
												/>
												<Select value={editUnit} onValueChange={(v) => setEditUnit(v as ProductUnit)}>
													<SelectTrigger size="sm" className="w-28">
														<SelectValue placeholder="Unidad" />
													</SelectTrigger>
													<SelectContent>
														{UNIT_OPTIONS.map((u) => (
															<SelectItem key={u} value={u}>{UNIT_LABELS[u]}</SelectItem>
														))}
													</SelectContent>
												</Select>
												<Button
													type="button"
													size="sm"
													variant="ghost"
													onClick={() => savePrice(item.productId)}
													disabled={saving}
													aria-label="Guardar precio"
												>
													<Check className="size-4" />
												</Button>
												<Button type="button" size="sm" variant="ghost" onClick={cancelEditing} aria-label="Cancelar">
													<X className="size-4" />
												</Button>
											</div>
										)
										: null}
								</div>
							);
						})}
					</div>
				)
				: null}

			<EntitySearch
				supabase={supabase}
				placeholder="Buscar o agregar producto..."
				searchFn={searchProducts}
				quickAddFn={quickAddProduct}
				getLabel={(p) => p.name}
				getId={(p) => p.id}
				quickAddNoun="producto"
				onSelect={(product) => onAdd(product.id, product.name, product.price_per_unit, product.unit as ProductUnit | null)}
			/>
		</div>
	);
}
