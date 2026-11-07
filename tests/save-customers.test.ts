import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { setupTenant, type TestTenant } from "@/tests/fixtures";
import { createOrder, quickAddCustomer, quickAddProduct, searchCustomers } from "@/lib/supabase/queries";
import { listCustomers, saveCustomersRpc } from "@/lib/customers/catalog";
import { normalizeTaxId } from "@/lib/customers/parse";
import type { CustomerSaveRow } from "@/lib/customers/grid";
import { saveProductsRpc } from "@/lib/products/catalog";

type Client = SupabaseClient<Database>;

// Pre-trigger data can only be recreated from outside the API roles.
const service: Client = createClient<Database>(
	process.env.NEXT_PUBLIC_SUPABASE_URL!,
	process.env.SUPABASE_SERVICE_ROLE_KEY!,
	{ auth: { persistSession: false, autoRefreshToken: false } },
);

let caller: Client;
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => caller }));

const { saveCustomers } = await import("@/app/(app)/customers/actions");

const newRow = (name: string, over: Partial<CustomerSaveRow> = {}): CustomerSaveRow => ({
	id: null, name, phone: null, address: null, tax_id: null, legal_name: null, nrc: null,
	cod_actividad: null, desc_actividad: null, email: null, department_code: null, municipality_code: null, district_code: null,
	active: true, updated_at: null, ...over,
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
			await service.from("customers").update({ tax_id: "NIT pendiente" }).eq("id", c.id);
			const { error } = await saveCustomersRpc(tenant.operator, [await editOf(legacy, { phone: "2222-1111" })]);
			expect(error).toBeNull();
			expect((await customer(tenant.admin, legacy)).tax_id).toBe("NIT pendiente");
			// Legacy whitespace isn't a "change": the grid sends values trimmed.
			await service.from("customers").update({ email: " x@y " }).eq("id", c.id);
			expect((await saveCustomersRpc(tenant.operator, [await editOf(legacy, { phone: "2222-2222", email: "x@y" })])).error).toBeNull();
		});

		it("swaps two names in one save, and reuses a freed name for a new row", async () =>
		{
			const [a, b, c] = [unique("Swap A"), unique("Swap B"), unique("Swap C")];
			await saveCustomersRpc(tenant.operator, [newRow(a), newRow(b)]);
			const rowA = await customer(tenant.admin, a);
			const rowB = await customer(tenant.admin, b);

			const { data, error } = await saveCustomersRpc(tenant.operator, [
				await editOf(a, { name: b }),
				await editOf(b, { name: a }),
			]);
			expect(error).toBeNull();
			expect(data?.saved).toBe(2);
			expect((await customer(tenant.admin, a)).id).toBe(rowB.id);
			expect((await customer(tenant.admin, b)).id).toBe(rowA.id);

			const moved = await saveCustomersRpc(tenant.operator, [newRow(a), await editOf(a, { name: c })]);
			expect(moved.error).toBeNull();
			expect((await customer(tenant.admin, c)).id).toBe(rowB.id);
			expect((await customer(tenant.admin, a)).id).not.toBe(rowB.id);
		});

		it("handles a rename chain, and a name that looks like another row's id", async () =>
		{
			const [a, b, c] = [unique("Chain A"), unique("Chain B"), unique("Chain C")];
			await saveCustomersRpc(tenant.operator, [newRow(a), newRow(b)]);
			const rowA = await customer(tenant.admin, a);
			const rowB = await customer(tenant.admin, b);
			expect((await saveCustomersRpc(tenant.operator, [await editOf(a, { name: b }), await editOf(b, { name: c })])).error).toBeNull();
			expect((await customer(tenant.admin, b)).id).toBe(rowA.id);
			expect((await customer(tenant.admin, c)).id).toBe(rowB.id);

			const [squatter, victim] = [unique("Squatter"), unique("Victim")];
			await saveCustomersRpc(tenant.operator, [newRow(squatter), newRow(victim)]);
			const target = await customer(tenant.admin, victim);
			await saveCustomersRpc(tenant.operator, [await editOf(squatter, { name: target.id })]);
			const renamed = unique("Victim renamed");
			expect((await saveCustomersRpc(tenant.operator, [await editOf(victim, { name: renamed })])).error).toBeNull();
		});

		it("a stale row is a conflict, not a format error on a value the user didn't touch", async () =>
		{
			const name = unique("Stale");
			await saveCustomersRpc(tenant.operator, [newRow(name)]);
			const row = await customer(tenant.admin, name);
			await service.from("customers").update({ tax_id: "NIT pendiente" }).eq("id", row.id);
			const stale = await editOf(name, {});
			await tenant.operator.from("customers").update({ tax_id: "06140101901011" }).eq("id", row.id);

			const { data, error } = await saveCustomersRpc(tenant.operator, [stale]);
			expect(error).toBeNull();
			expect(data?.conflicts).toHaveLength(1);
		});

		it("rejects the same id twice in one save", async () =>
		{
			const name = unique("Twice");
			await saveCustomersRpc(tenant.operator, [newRow(name)]);
			const edit = await editOf(name, {});
			const { error } = await saveCustomersRpc(tenant.operator, [{ ...edit, name: unique("Twice C") }, { ...edit, name: unique("Twice D") }]);
			expect(error?.code).toBe("22023");
			expect((await customer(tenant.admin, name)).id).toBe(edit.id);
		});

		it.each([
			["tax_id", "123", "06140101901011", "0614-010190-101-1"],
			["nrc", "abc", "1234567", "123456-7"],
			["email", "x@y", " a@b.co ", "a@b.co"],
			["cod_actividad", "12", " 12345 ", "12345"],
		] as const)("direct update of %s: rejects, canonicalizes, ignores padding, clears", async (field, bad, good, canonical) =>
		{
			const name = unique("Direct update");
			await saveCustomersRpc(tenant.operator, [newRow(name)]);
			const row = await customer(tenant.admin, name);
			const update = (value: string) => tenant.operator.from("customers").update({ [field]: value } as { email: string }).eq("id", row.id);

			expect((await update(bad)).error?.code).toBe("22023");
			expect((await update(good)).error).toBeNull();
			expect((await customer(tenant.admin, name))[field]).toBe(canonical);
			expect((await update(`${canonical} `)).error).toBeNull();
			expect((await customer(tenant.admin, name))[field]).toBe(canonical);
			expect((await update("")).error).toBeNull();
			expect((await customer(tenant.admin, name))[field]).toBeNull();
		});

		it("direct table writes can't skip the formats: rejected, stored canonical, legacy values stay", async () =>
		{
			const direct = () => tenant.operator.from("customers");

			for (const bad of [{ tax_id: "123" }, { nrc: "abc" }, { email: "x@y" }, { cod_actividad: "12" }])
			{
				const { error } = await direct().insert({ tenant_id: tenant.tenantId, name: unique("Direct bad"), ...bad });
				expect(error?.code).toBe("22023");
			}

			const name = unique("Direct good");
			const { error } = await direct().insert({
				tenant_id: tenant.tenantId, name, tax_id: "06140101901011", nrc: "1234567", email: " a@b.co ", cod_actividad: " 12345 ",
			});
			expect(error).toBeNull();
			expect(await customer(tenant.admin, name)).toMatchObject({
				tax_id: "0614-010190-101-1", nrc: "123456-7", email: "a@b.co", cod_actividad: "12345",
			});

			const legacy = unique("Direct legacy");
			await saveCustomersRpc(tenant.operator, [newRow(legacy)]);
			const row = await customer(tenant.admin, legacy);
			await service.from("customers").update({ tax_id: "NIT pendiente" }).eq("id", row.id);

			expect((await direct().update({ phone: "2222-3333" }).eq("id", row.id)).error).toBeNull();
			expect((await direct().update({ tax_id: "NIT pendiente" }).eq("id", row.id)).error).toBeNull();
			expect((await direct().update({ tax_id: "otro" }).eq("id", row.id)).error?.code).toBe("22023");
			expect((await direct().update({ tax_id: "" }).eq("id", row.id)).error).toBeNull();
			expect((await customer(tenant.admin, legacy)).tax_id).toBeNull();
		});

		it("direct table writes can't skip the name and length limits", async () =>
		{
			const direct = () => tenant.operator.from("customers");

			for (const bad of [
				{ name: "" }, { name: " \t\n" }, { name: "x".repeat(201) },
				{ phone: "1".repeat(101) }, { address: "x".repeat(501) },
				{ legal_name: "x".repeat(201) }, { desc_actividad: "x".repeat(201) },
				{ email: `${"a".repeat(250)}@b.co` },
			])
			{
				const { error } = await direct().insert({ tenant_id: tenant.tenantId, name: unique("Direct long"), ...bad });
				expect(error?.code, JSON.stringify(bad).slice(0, 40)).toBe("23514");
			}

			const name = unique("Direct ok");
			expect((await direct().insert({
				tenant_id: tenant.tenantId, name, phone: "1".repeat(100), address: "x".repeat(500),
			})).error).toBeNull();
			const row = await customer(tenant.admin, name);
			expect((await direct().update({ name: "   " }).eq("id", row.id)).error?.code).toBe("23514");

			// quick_add_customer() never had a length limit of its own.
			expect((await quickAddCustomer(tenant.operator, "x".repeat(201))).error?.code).toBe("23514");
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

		it("renames a full 1000-row batch within the statement timeout", async () =>
		{
			const names = Array.from({ length: 1000 }, (_, i) => `${unique("Ciclo")} cliente ${i}`);
			await saveCustomersRpc(tenant.operator, names.map((name) => newRow(name)));
			const { data: rows } = await tenant.admin.from("customers").select("*").like("name", "Ciclo %").limit(1000);
			const edits = rows!.map((r, i) => ({ ...newRow(r.name), id: r.id, updated_at: r.updated_at, name: rows![(i + 1) % rows!.length].name }));

			const { data, error } = await saveCustomersRpc(tenant.operator, edits);
			expect(error).toBeNull();
			expect(data!.saved).toBe(1000);
		}, 30_000);

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
		it.each(["0614-010190-101-3", "6140101901013", "12345678", "2222-3333", "01234567-8", "N/A", "123"])("%s", async (value) =>
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
			// A name with a number is a name search, not a phone search.
			const other = unique("Zeta");
			await saveCustomersRpc(tenant.operator, [newRow(other, { phone: "2000-4455" })]);
			const z = await customer(tenant.operator, other);
			expect((await searchCustomers(tenant.operator, "Ferretería 2000")).data!.map((x) => x.id)).not.toContain(z.id);
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
