"use client";

import { X } from "lucide-react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { searchProducts, quickAddProduct } from "@/lib/supabase/queries";
import { EntitySearch } from "@/components/capture/entity-search";
import { Label } from "@/components/ui/label";

export interface LineItem
{
	productId: string;
	productName: string;
	quantity: number;
}

interface LineItemsProps
{
	supabase: SupabaseClient<Database>;
	items: LineItem[];
	onAdd: (productId: string, productName: string) => void;
	onQuantityChange: (productId: string, quantity: number) => void;
	onRemove: (productId: string) => void;
}

export function LineItems({ supabase, items, onAdd, onQuantityChange, onRemove }: LineItemsProps)
{
	return (
		<div className="flex flex-col gap-3">
			<Label>Productos {items.length > 0 ? <span className="font-mono text-xs font-normal text-muted-foreground">· {items.length} líneas</span> : null}</Label>

			{items.length > 0
				? (
					<div className="flex flex-col divide-y divide-border rounded-md border border-border">
						{items.map((item) => (
							<div key={item.productId} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 px-3 py-2">
								<span className="truncate text-sm font-medium">{item.productName}</span>
								<input
									type="number"
									min="0.01"
									step="0.01"
									value={item.quantity}
									onChange={(e) => onQuantityChange(item.productId, Number(e.target.value))}
									className="w-20 rounded-sm border border-input bg-transparent px-2 py-1 text-right font-mono text-sm tabular-nums outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
								/>
								<button
									type="button"
									onClick={() => onRemove(item.productId)}
									aria-label={`Quitar ${item.productName}`}
									className="text-muted-foreground hover:text-destructive"
								>
									<X className="size-4" />
								</button>
							</div>
						))}
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
				onSelect={(product) => onAdd(product.id, product.name)}
			/>
		</div>
	);
}
