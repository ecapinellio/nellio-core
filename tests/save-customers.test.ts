import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { setupTenant, type TestTenant } from "@/tests/fixtures";
import { createOrder, quickAddCustomer, quickAddProduct, searchCustomers } from "@/lib/supabase/queries";
import { listCustomers, saveCustomersRpc } from "@/lib/customers/catalog";
import { normalizeTaxId } from "@/lib/customers/parse";
import type { CustomerSaveRow } from "@/lib/customers/grid";
import { saveProductsRpc } from "@/lib/products/catalog";

type Client = SupabaseClient<Database>;

let caller: Client;
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => caller }));

const { saveCustomers } = await import("@/app/(app)/customers/actions");

const newRow = (name: string, over: Partial<CustomerSaveRow> = {}): CustomerSaveRow => ({
	id: null, name, phone: null, address: null, tax_id: null, legal_name: null, nrc: null,
	cod_actividad: null, desc_actividad: null, email: null, active: true, updated_at: null, ...over,
});

describe("customers: save_customers(), formats, deactivation, capture search", () =>
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

	async function customer(client: Client, name: string)
	{
		const { data } = await client.from("customers").select("*").eq("name", name).single();
		return data!;
	}

	/** An update row built from what's stored, so only `over` changes. */
	async function editOf(name: string, over: Partial<CustomerSaveRow>): Promise<CustomerSaveRow>
	{
		const c = await customer(tenant.admin, name);
		return { ...newRow(c.name), ...c, ...over, id: c.id, updated_at: c.updated_at } as CustomerSaveRow;
	}

	describe("save_customers() RPC", () =>
	{
		it("inserts and updates, canonicalizes NIT/DUI and NRC, and stamps updated_by", async () =>
		{
			const a = unique("Super Selectos Escalón");
			const b = unique("Ferretería López");
			const { data, error } = await saveCustomersRpc(tenant.operator, [
				newRow(a, { tax_id: "6140101901013", nrc: "1234567", phone: "2222-3333 / 7777-8888" }),
				newRow(b, { tax_id: "12345678" }),
			]);
			expect(error).toBeNull();
			expect(data).toEqual({ saved: 2, conflicts: [] });
			expect(await customer(tenant.admin, a)).toMatchObject({ tax_id: "0614-010190-101-3", nrc: "123456-7", phone: "2222-3333 / 7777-8888", updated_by: tenant.operatorId });
			expect((await customer(tenant.admin, b)).tax_id).toBe("01234567-8");
		});

		it("a grid save without panel keys keeps the panel fields (outside voice #2)", async () =>
		{
			const name = unique("Panel");
			await saveCustomersRpc(tenant.operator, [newRow(name, { legal_name: "Panel S.A. de C.V.", email: "compras@panel.sv" })]);
			const c = await customer(tenant.operator, name);
			const gridOnly = { id: c.id, name, phone: "2222-0000", address: null, tax_id: null, active: true, updated_at: c.updated_at };
			const { error } = await saveCustomersRpc(tenant.operator, [gridOnly as unknown as CustomerSaveRow]);
			expect(error).toBeNull();
			expect(await customer(tenant.admin, name)).toMatchObject({ phone: "2222-0000", legal_name: "Panel S.A. de C.V.", email: "compras@panel.sv" });
		});

		it("rejects invalid formats on new values, but a legacy value can stay while other fields change", async () =>
		{
			expect((await saveCustomersRpc(tenant.operator, [newRow(unique("Bad NIT"), { tax_id: "123" })])).error?.message).toContain("NIT o DUI");
			expect((await saveCustomersRpc(tenant.operator, [newRow(unique("Bad NRC"), { nrc: "abc" })])).error?.message).toContain("NRC");
			expect((await saveCustomersRpc(tenant.operator, [newRow(unique("Bad mail"), { email: "x@y" })])).error?.message).toContain("correo");
			expect((await saveCustomersRpc(tenant.operator, [newRow(unique("Bad act"), { cod_actividad: "12" })])).error?.message).toContain("actividad");

			const legacy = unique("Legacy");
			await saveCustomersRpc(tenant.operator, [newRow(legacy)]);
			const c = await customer(tenant.admin, legacy);
			await tenant.admin.from("customers").update({ tax_id: "NIT pendiente" }).eq("id", c.id);
			const { error } = await saveCustomersRpc(tenant.operator, [await editOf(legacy, { phone: "2222-1111" })]);
			expect(error).toBeNull();
			expect((await customer(tenant.admin, legacy)).tax_id).toBe("NIT pendiente");
		});

		it("is all-or-nothing, takes tenant from the JWT, rejects foreign ids and drivers", async () =>
		{
			const good = unique("Good");
			expect((await saveCustomersRpc(tenant.operator, [newRow(good), newRow(unique("Bad"), { tax_id: "1" })])).error).not.toBeNull();
			expect((await tenant.admin.from("customers").select("id").eq("name", good)).data).toEqual([]);

			const smuggled = unique("Smuggled");
			await saveCustomersRpc(tenant.operator, [{ ...newRow(smuggled), tenant_id: otherTenant.tenantId } as CustomerSaveRow]);
			expect((await customer(tenant.admin, smuggled)).tenant_id).toBe(tenant.tenantId);

			const foreign = unique("Foreign");
			await saveCustomersRpc(otherTenant.admin, [newRow(foreign)]);
			const f = await customer(otherTenant.admin, foreign);
			expect((await saveCustomersRpc(tenant.operator, [{ ...newRow("Hijack"), id: f.id, updated_at: f.updated_at }])).error?.code).toBe("P0002");

			expect((await saveCustomersRpc(tenant.driver, [newRow(unique("Driver"))])).error?.code).toBe("42501");
		});

		it("conflicts: nothing written, payload has who + panel fields; concurrent saves never lose an update", async () =>
		{
			const name = unique("Contested");
			await saveCustomersRpc(tenant.admin, [newRow(name)]);
			const loaded = await customer(tenant.operator, name);

			await saveCustomersRpc(tenant.admin, [{ ...newRow(name, { nrc: "7654321" }), id: loaded.id, updated_at: loaded.updated_at }]);
			const stale = await saveCustomersRpc(tenant.operator, [{ ...newRow(name, { phone: "2222-9999" }), id: loaded.id, updated_at: loaded.updated_at }]);
			expect(stale.data!.saved).toBe(0);
			expect(stale.data!.conflicts).toEqual([expect.objectContaining({ id: loaded.id, nrc: "765432-1", updated_by_name: expect.any(String) })]);

			const race = unique("Race");
			await saveCustomersRpc(tenant.admin, [newRow(race)]);
			const r = await customer(tenant.admin, race);
			const edit = (phone: string) => ({ ...newRow(race, { phone }), id: r.id, updated_at: r.updated_at });
			const [x, y] = await Promise.all([saveCustomersRpc(tenant.admin, [edit("1111-1111")]), saveCustomersRpc(tenant.operator, [edit("2222-2222")])]);
			expect([x.data!.saved, y.data!.saved].sort()).toEqual([0, 1]);
		});

		it("duplicate names (case/accents/spaces) are rejected — branches need distinct names (D8)", async () =>
		{
			const base = unique("Super Selectos");
			await saveCustomersRpc(tenant.operator, [newRow(base)]);
			const dup = await saveCustomersRpc(tenant.operator, [newRow(` ${base.toUpperCase()} `)]);
			expect(dup.error?.code).toBe("23505");
			expect(dup.error?.message).toContain("Ya existe");
		});

		it("saves a full 1000-row batch within the statement timeout, caps at 1000", async () =>
		{
			const rows = Array.from({ length: 1000 }, (_, i) => newRow(`${unique("Lote")} cliente ${i}`, { tax_id: "0614-010190-101-3" }));
			const { data, error } = await saveCustomersRpc(tenant.operator, rows);
			expect(error).toBeNull();
			expect(data!.saved).toBe(1000);
			expect((await saveCustomersRpc(tenant.operator, Array.from({ length: 1001 }, (_, i) => newRow(`Tope ${i}`)))).error?.code).toBe("22023");
		}, 30_000);
	});

	describe("normalize_tax_id() / normalize_name() mirror the TS rules", () =>
	{
		it.each(["0614-010190-101-3", "6140101901013", "12345678", "01234567-8", "N/A", "123"])("%s", async (value) =>
		{
			const { data } = await tenant.operator.rpc("normalize_tax_id", { p_value: value });
			expect(data).toBe(normalizeTaxId(value)?.value ?? null);
		});
	});

	describe("deactivation and capture", () =>
	{
		it("hides inactive customers from search, blocks new orders and repoints, keeps old orders", async () =>
		{
			const name = unique("Retirado");
			await saveCustomersRpc(tenant.operator, [newRow(name, { phone: "7012-3456" })]);
			const c = await customer(tenant.operator, name);
			const { data: product } = await quickAddProduct(tenant.operator, unique("Producto"));
			const { data: oldOrder } = await createOrder(tenant.operator, {
				customer_id: c.id, notes: null, channel: "whatsapp", items: [{ product_id: product!.id, quantity: 1 }],
			});

			await saveCustomersRpc(tenant.operator, [await editOf(name, { active: false })]);
			expect((await searchCustomers(tenant.operator, name)).data!.map((x) => x.id)).not.toContain(c.id);

			const blocked = await createOrder(tenant.operator, {
				customer_id: c.id, notes: null, channel: "whatsapp", items: [{ product_id: product!.id, quantity: 1 }],
			});
			expect(blocked.error?.message).toContain("ya no está activo");

			const { data: other } = await quickAddCustomer(tenant.operator, unique("Activo"));
			const { data: otherOrder } = await createOrder(tenant.operator, {
				customer_id: other!.id, notes: null, channel: "whatsapp", items: [{ product_id: product!.id, quantity: 1 }],
			});
			const repoint = await tenant.operator.from("orders").update({ customer_id: c.id }).eq("id", otherOrder!.order.id);
			expect(repoint.error?.message).toContain("ya no está activo");

			const { data: kept } = await tenant.operator.from("orders").select("customer_id").eq("id", oldOrder!.order.id).single();
			expect(kept!.customer_id).toBe(c.id);
		});

		it("search finds customers by the WhatsApp phone digits or NIT digits (D9)", async () =>
		{
			const name = unique("Distribuidora del Pacífico");
			await saveCustomersRpc(tenant.operator, [newRow(name, { phone: "+503 7788-9911", tax_id: "05119999991011" })]);
			const c = await customer(tenant.operator, name);
			expect((await searchCustomers(tenant.operator, "77889911")).data!.map((x) => x.id)).toContain(c.id);
			expect((await searchCustomers(tenant.operator, "7788 9911")).data!.map((x) => x.id)).toContain(c.id);
			expect((await searchCustomers(tenant.operator, "0511-999999-101-1")).data!.map((x) => x.id)).toContain(c.id);
			// A phone match ranks first even among many name/NIT matches.
			expect((await searchCustomers(tenant.operator, "77889911")).data![0].id).toBe(c.id);
		});

		it("quick-add explains a duplicate, and points to reactivation when it's deactivated (outside voice #6)", async () =>
		{
			const name = unique("Duplicado");
			await quickAddCustomer(tenant.operator, name);
			expect((await quickAddCustomer(tenant.operator, name.toUpperCase())).error?.message).toBe("Ya existe un cliente con ese nombre.");

			await saveCustomersRpc(tenant.operator, [await editOf(name, { active: false })]);
			expect((await quickAddCustomer(tenant.operator, name)).error?.message).toContain("desactivado");

			const product = unique("Producto viejo");
			await saveProductsRpc(tenant.operator, [{ id: null, name: product, price_per_unit: 5, unit: "kg", active: false, updated_at: null }]);
			expect((await quickAddProduct(tenant.operator, product)).error?.message).toContain("desactivado");
		});

		it("listCustomers returns active first, with sub-second updated_at", async () =>
		{
			const { data } = await listCustomers(tenant.operator);
			expect(data!.length).toBeGreaterThan(0);
			expect(data![0].active).toBe(true);
			expect(data![0].updated_at).toMatch(/\.\d+/);
		});
	});

	describe("saveCustomers() Server Action", () =>
	{
		it("saves for an operator, rejects a driver, re-validates rows", async () =>
		{
			expect(await saveCustomers([newRow(unique("Acción"))])).toEqual({ status: "saved", saved: 1 });
			expect(await saveCustomers([{ ...newRow(unique("Largo")), phone: "9".repeat(101) }])).toMatchObject({ status: "error" });
			expect(await saveCustomers([newRow(unique("Formato"), { tax_id: "123" })])).toMatchObject({ status: "error", error: expect.stringContaining("NIT o DUI") });

			caller = tenant.driver;
			expect(await saveCustomers([newRow(unique("Nope"))])).toEqual({ status: "error", error: "No autorizado." });
		});
	});
});
