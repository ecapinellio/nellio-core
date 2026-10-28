import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { setupTenant, type TestTenant } from "@/tests/fixtures";
import { createOrder, quickAddCustomer, quickAddProduct, searchProducts } from "@/lib/supabase/queries";
import { listCatalog, saveProductsRpc } from "@/lib/products/catalog";
import { normalizeProductName, type SaveRow } from "@/lib/products/grid";

type Client = SupabaseClient<Database>;

// Same seam as manage-users.test.ts: only the cookie plumbing is swapped.
let caller: Client;
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => caller }));

const { saveProducts } = await import("@/app/(app)/products/actions");

const newRow = (name: string, price = 10, unit: SaveRow["unit"] = "kg"): SaveRow =>
	({ id: null, name, price_per_unit: price, unit, active: true, updated_at: null });

describe("product catalog: save_products(), deactivation, duplicates", () =>
{
	let tenant: TestTenant;
	let otherTenant: TestTenant;
	let n = 0;
	const unique = (base: string) => `${base} ${++n}`;

	beforeAll(async () =>
	{
		[tenant, otherTenant] = await Promise.all([setupTenant(), setupTenant()]);
	});

	afterAll(async () =>
	{
		await Promise.all([tenant.teardown(), otherTenant.teardown()]);
	});

	beforeEach(() =>
	{
		caller = tenant.operator;
	});

	async function product(client: Client, name: string)
	{
		const { data } = await client.from("products").select("*").eq("name", name).single();
		return data!;
	}

	describe("save_products() RPC", () =>
	{
		it("inserts and updates in one call, with updated_by from the session", async () =>
		{
			const existing = unique("Cloro");
			await saveProductsRpc(tenant.admin, [newRow(existing, 12.5, "gal")]);
			const before = await product(tenant.admin, existing);

			const added = unique("Soda cáustica");
			const { data, error } = await saveProductsRpc(tenant.operator, [
				{ id: before.id, name: existing, price_per_unit: 13, unit: "gal", active: true, updated_at: before.updated_at },
				newRow(added, 1250, "ton"),
			]);

			expect(error).toBeNull();
			expect(data).toEqual({ saved: 2, conflicts: [] });
			const after = await product(tenant.admin, existing);
			expect(after.price_per_unit).toBe(13);
			expect(after.updated_by).toBe(tenant.operatorId);
			expect((await product(tenant.admin, added)).tenant_id).toBe(before.tenant_id);
		});

		it("round-trips updated_at as text without false conflicts (µs precision)", async () =>
		{
			const name = unique("Precision");
			await saveProductsRpc(tenant.operator, [newRow(name)]);
			const { data: catalog } = await listCatalog(tenant.operator);
			const row = catalog!.find((p) => p.name === name)!;
			expect(row.updated_at).toMatch(/\.\d{6}/);

			const { data } = await saveProductsRpc(tenant.operator, [
				{ id: row.id, name, price_per_unit: 11, unit: "kg", active: true, updated_at: row.updated_at },
			]);
			expect(data!.conflicts).toEqual([]);
		});

		it("is all-or-nothing: one bad row writes nothing", async () =>
		{
			const good = unique("Good");
			const { error } = await saveProductsRpc(tenant.operator, [newRow(good), newRow(unique("Bad"), -1)]);
			expect(error?.code).toBe("22003");
			expect((await tenant.admin.from("products").select("id").eq("name", good)).data).toEqual([]);
		});

		it("takes tenant_id from the JWT, ignoring one smuggled into a row", async () =>
		{
			const name = unique("Smuggled");
			const row = { ...newRow(name), tenant_id: otherTenant.tenantId } as SaveRow;
			await saveProductsRpc(tenant.operator, [row]);
			expect((await product(tenant.admin, name)).tenant_id).not.toBe(otherTenant.tenantId);
		});

		it("rejects an id from another tenant instead of silently skipping it", async () =>
		{
			const foreign = unique("Foreign");
			await saveProductsRpc(otherTenant.admin, [newRow(foreign)]);
			const target = await product(otherTenant.admin, foreign);

			const { error } = await saveProductsRpc(tenant.operator, [
				{ id: target.id, name: "Hijacked", price_per_unit: 1, unit: "kg", active: true, updated_at: target.updated_at },
			]);
			expect(error?.code).toBe("P0002");
			expect((await product(otherTenant.admin, foreign)).price_per_unit).toBe(10);
		});

		it("two simultaneous saves of the same row: one wins, the other gets a conflict (no lost update)", async () =>
		{
			const name = unique("Race");
			await saveProductsRpc(tenant.admin, [newRow(name)]);
			const p = await product(tenant.admin, name);
			const edit = (price: number) => ({ id: p.id, name, price_per_unit: price, unit: "kg" as const, active: true, updated_at: p.updated_at });

			const [a, b] = await Promise.all([saveProductsRpc(tenant.admin, [edit(20)]), saveProductsRpc(tenant.operator, [edit(30)])]);
			const results = [a.data!, b.data!];
			expect(results.filter((r) => r.saved === 1)).toHaveLength(1);
			expect(results.filter((r) => r.conflicts.length === 1)).toHaveLength(1);
			const winner = a.data!.saved === 1 ? 20 : 30;
			expect((await product(tenant.admin, name)).price_per_unit).toBe(winner);
		});

		it("rejects prices numeric(10,2) can't hold instead of rounding or overflowing", async () =>
		{
			expect((await saveProductsRpc(tenant.operator, [newRow(unique("Huge"), 123456789)])).error?.message).toContain("no es válido");
			expect((await saveProductsRpc(tenant.operator, [newRow(unique("Tiny"), 1.005)])).error?.message).toContain("no es válido");
		});

		it("rejects a driver", async () =>
		{
			const { error } = await saveProductsRpc(tenant.driver, [newRow(unique("Driver"))]);
			expect(error?.code).toBe("42501");
		});

		it("returns conflicts with who/what and writes nothing; re-sending with the new updated_at wins", async () =>
		{
			const name = unique("Contested");
			await saveProductsRpc(tenant.admin, [newRow(name, 12.5, "gal")]);
			const loaded = await product(tenant.operator, name);

			// Admin saves first.
			await saveProductsRpc(tenant.admin, [
				{ id: loaded.id, name, price_per_unit: 13, unit: "gal", active: true, updated_at: loaded.updated_at },
			]);

			const other = unique("Untouched");
			const stale = await saveProductsRpc(tenant.operator, [
				{ id: loaded.id, name, price_per_unit: 12, unit: "gal", active: true, updated_at: loaded.updated_at },
				newRow(other),
			]);
			expect(stale.error).toBeNull();
			expect(stale.data!.saved).toBe(0);
			expect(stale.data!.conflicts).toEqual([
				expect.objectContaining({ id: loaded.id, name, price_per_unit: 13, unit: "gal", updated_by_name: expect.any(String) }),
			]);
			expect((await tenant.admin.from("products").select("id").eq("name", other)).data).toEqual([]);

			// "Guardar el mío igual": re-send with the current updated_at.
			const forced = await saveProductsRpc(tenant.operator, [
				{ id: loaded.id, name, price_per_unit: 12, unit: "gal", active: true, updated_at: stale.data!.conflicts[0].updated_at },
			]);
			expect(forced.data).toEqual({ saved: 1, conflicts: [] });
			expect((await product(tenant.admin, name)).price_per_unit).toBe(12);
		});

		it("rejects duplicates ignoring case, accents and spaces — in the batch and vs the catalog", async () =>
		{
			const base = unique("Cloro");
			await saveProductsRpc(tenant.operator, [newRow(`${base} 5%`)]);

			const vsCatalog = await saveProductsRpc(tenant.operator, [newRow(`${base.toUpperCase()} 5 %`)]);
			expect(vsCatalog.error?.code).toBe("23505");
			expect(vsCatalog.error?.message).toContain("Ya existe");

			const inBatch = await saveProductsRpc(tenant.operator, [newRow(unique("Ácido")), newRow(`Acido ${n}`)]);
			expect(inBatch.error?.code).toBe("23505");
		});

		// Regression: the duplicate check was O(n²) and hit Supabase's 8s
		// statement timeout for the `authenticated` role at 1000 rows.
		it("saves a full 1000-row batch within the statement timeout", async () =>
		{
			const rows = Array.from({ length: 1000 }, (_, i) => newRow(`${unique("Lote")} ítem ${i}`));
			const { data, error } = await saveProductsRpc(tenant.operator, rows);
			expect(error).toBeNull();
			expect(data!.saved).toBe(1000);
		}, 30_000);

		it("caps a save at 1000 rows", async () =>
		{
			const rows = Array.from({ length: 1001 }, (_, i) => newRow(`Bulk ${i}`));
			const { error } = await saveProductsRpc(tenant.operator, rows);
			expect(error?.code).toBe("22023");
		});

		it("lets a quick-added product without price be renamed/deactivated, but not clear an existing price", async () =>
		{
			const { data: quick } = await quickAddProduct(tenant.operator, unique("Quick"));
			const renamed = unique("Quick renamed");
			const { error } = await saveProductsRpc(tenant.operator, [
				{ id: quick!.id, name: renamed, price_per_unit: null, unit: null, active: false, updated_at: quick!.updated_at },
			]);
			expect(error).toBeNull();
			expect(await product(tenant.admin, renamed)).toMatchObject({ active: false, price_per_unit: null });

			const priced = unique("Priced");
			await saveProductsRpc(tenant.operator, [newRow(priced)]);
			const p = await product(tenant.operator, priced);
			const cleared = await saveProductsRpc(tenant.operator, [
				{ id: p.id, name: priced, price_per_unit: null, unit: "kg", active: true, updated_at: p.updated_at },
			]);
			expect(cleared.error?.code).toBe("22004");
		});

		it("requires price and unit on new products", async () =>
		{
			const { error } = await saveProductsRpc(tenant.operator, [{ ...newRow(unique("No price")), price_per_unit: null }]);
			expect(error?.code).toBe("22004");
		});
	});

	describe("normalize_product_name() mirrors normalizeProductName()", () =>
	{
		it.each(["Cloro 5%", "CLORO 5 %", "  Ácido  Muriático ", "Soda cáustica", "Niño"])("%s", async (name) =>
		{
			const { data } = await tenant.operator.rpc("normalize_product_name", { p_name: name });
			expect(data).toBe(normalizeProductName(name));
		});
	});

	describe("deactivation", () =>
	{
		it("hides inactive products from capture search and blocks ordering them; old orders keep them", async () =>
		{
			const name = unique("Retired");
			await saveProductsRpc(tenant.operator, [newRow(name)]);
			const p = await product(tenant.operator, name);
			const { data: customer } = await quickAddCustomer(tenant.operator, unique("Customer"));

			const { data: oldOrder } = await createOrder(tenant.operator, {
				customer_id: customer!.id, notes: null, channel: "whatsapp", items: [{ product_id: p.id, quantity: 1 }],
			});
			expect(oldOrder).not.toBeNull();

			await saveProductsRpc(tenant.operator, [{ id: p.id, name, price_per_unit: 10, unit: "kg", active: false, updated_at: p.updated_at }]);

			expect((await searchProducts(tenant.operator, name)).data!.map((x) => x.id)).not.toContain(p.id);

			const blocked = await createOrder(tenant.operator, {
				customer_id: customer!.id, notes: null, channel: "whatsapp", items: [{ product_id: p.id, quantity: 1 }],
			});
			expect(blocked.error?.message).toContain("ya no está activo");

			// Direct insert path (operators have an order_items insert policy).
			const direct = await tenant.operator.from("order_items").insert({ order_id: oldOrder!.order.id, product_id: p.id, quantity: 2, tenant_id: tenant.tenantId });
			expect(direct.error?.message).toContain("ya no está activo");

			// The old order still shows the retired product, and edits that don't
			// touch product_id still work on it.
			const { data: line } = await tenant.operator.from("order_items").select("id, product_id").eq("order_id", oldOrder!.order.id).single();
			expect(line!.product_id).toBe(p.id);
			expect((await tenant.operator.from("order_items").update({ quantity: 3 }).eq("id", line!.id)).error).toBeNull();

			// Repointing a line at the retired product is blocked too.
			const { data: active } = await quickAddProduct(tenant.operator, unique("Still active"));
			const { data: otherOrder } = await createOrder(tenant.operator, {
				customer_id: customer!.id, notes: null, channel: "whatsapp", items: [{ product_id: active!.id, quantity: 1 }],
			});
			const { data: otherLine } = await tenant.operator.from("order_items").select("id").eq("order_id", otherOrder!.order.id).single();
			const repoint = await tenant.operator.from("order_items").update({ product_id: p.id }).eq("id", otherLine!.id);
			expect(repoint.error?.message).toContain("ya no está activo");

			// Reactivate → searchable again.
			const inactive = await product(tenant.operator, name);
			await saveProductsRpc(tenant.operator, [{ id: p.id, name, price_per_unit: 10, unit: "kg", active: true, updated_at: inactive.updated_at }]);
			expect((await searchProducts(tenant.operator, name)).data!.map((x) => x.id)).toContain(p.id);
		});
	});

	describe("tenant-scoped foreign keys", () =>
	{
		it("rejects an order line pointing at another tenant's product, and an order at another tenant's customer", async () =>
		{
			const { data: foreignProduct } = await quickAddProduct(otherTenant.operator, unique("Foreign product"));
			const { data: foreignCustomer } = await quickAddCustomer(otherTenant.operator, unique("Foreign customer"));
			const { data: mine } = await quickAddProduct(tenant.operator, unique("Mine"));
			const { data: customer } = await quickAddCustomer(tenant.operator, unique("My customer"));
			const { data: order } = await createOrder(tenant.operator, {
				customer_id: customer!.id, notes: null, channel: "whatsapp", items: [{ product_id: mine!.id, quantity: 1 }],
			});

			const line = await tenant.operator.from("order_items")
				.insert({ order_id: order!.order.id, product_id: foreignProduct!.id, quantity: 1, tenant_id: tenant.tenantId });
			expect(line.error?.code).toBe("23503");

			const repointed = await tenant.operator.from("orders").update({ customer_id: foreignCustomer!.id }).eq("id", order!.order.id);
			expect(repointed.error?.code).toBe("23503");
		});
	});

	describe("quick_add_product()", () =>
	{
		it("maps a near-duplicate to a clean 'ya existe' error and stamps updated_by", async () =>
		{
			const name = unique("Desengrasante");
			const { data: first } = await quickAddProduct(tenant.operator, name);
			expect(first!.updated_by).toBe(tenant.operatorId);

			const { error } = await quickAddProduct(tenant.operator, `  ${name.toUpperCase()} `);
			expect(error?.code).toBe("23505");
			expect(error?.message).toBe("Ya existe un producto con ese nombre.");
		});
	});

	describe("saveProducts() Server Action", () =>
	{
		it("saves for an operator", async () =>
		{
			expect(await saveProducts([newRow(unique("Action"))])).toEqual({ status: "saved", saved: 1 });
		});

		it("rejects a driver before touching the DB", async () =>
		{
			caller = tenant.driver;
			expect(await saveProducts([newRow(unique("Nope"))])).toEqual({ status: "error", error: "No autorizado." });
		});

		it("re-validates rows the grid would have blocked", async () =>
		{
			expect(await saveProducts([newRow(unique("Big"), 100_000_000)])).toMatchObject({ status: "error", error: expect.stringContaining("no es válido") });
			expect(await saveProducts([newRow(unique("Neg"), -5)])).toMatchObject({ status: "error", error: expect.stringContaining("mayor que cero") });
			expect(await saveProducts([{ ...newRow(unique("Unit")), unit: "saco" as SaveRow["unit"] }])).toMatchObject({ status: "error", error: expect.stringContaining("no es válida") });
			expect(await saveProducts([])).toMatchObject({ status: "error" });
		});

		it("passes duplicates through as a readable message and conflicts as their own status", async () =>
		{
			const name = unique("Dup action");
			await saveProducts([newRow(name)]);
			expect(await saveProducts([newRow(name.toUpperCase())])).toMatchObject({ status: "error", error: expect.stringContaining("Ya existe") });

			const p = await product(tenant.operator, name);
			await saveProductsRpc(tenant.admin, [{ id: p.id, name, price_per_unit: 20, unit: "kg", active: true, updated_at: p.updated_at }]);
			const result = await saveProducts([{ id: p.id, name, price_per_unit: 30, unit: "kg", active: true, updated_at: p.updated_at }]);
			expect(result.status).toBe("conflicts");
		});
	});
});
