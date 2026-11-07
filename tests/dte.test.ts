import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { setupTenant, type TestTenant } from "@/tests/fixtures";
import { createOrder, quickAddCustomer, quickAddProduct } from "@/lib/supabase/queries";

vi.mock("server-only", () => ({}));
const { processPendingDtes } = await import("@/lib/dte/process");

const SEAL = "2026A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8";
const KEY_PASSWORD = "Clave-Privada-1";

function testCertificate(): string
{
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const der = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
	return `<CertificadoMH><privateKey><encodied>${der}</encodied>` +
		`<clave>${createHash("sha512").update(KEY_PASSWORD).digest("hex")}</clave></privateKey></CertificadoMH>`;
}

type Reply = Record<string, unknown> | "down";

/** Fake Hacienda: auth always OK, consultadte "not found", recepciondte answers `reply`. */
const realFetch = globalThis.fetch;

function fakeHacienda(reply: Reply)
{
	const sent: { url: string; body: unknown }[] = [];
	vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit) =>
	{
		const url = String(input instanceof Request ? input.url : input);
		if (!url.includes("dtes.mh.gob.sv"))
		{
			return realFetch(input, init); // Supabase
		}
		const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
		if (url.endsWith("/seguridad/auth"))
		{
			return json({ status: "OK", body: { token: "Bearer test" } });
		}
		if (url.includes("/consultadte"))
		{
			return json({ estado: null }, 404);
		}
		sent.push({ url, body: JSON.parse(String(init.body)) });
		if (reply === "down")
		{
			throw new TypeError("fetch failed");
		}
		return json(reply, reply.estado === "PROCESADO" ? 200 : 400);
	}));
	return sent;
}

const processed = { estado: "PROCESADO", selloRecibido: SEAL, fhProcesamiento: "07/11/2026 14:30:15", observaciones: [] };
const rejected = { estado: "RECHAZADO", selloRecibido: null, descripcionMsg: "[receptor.nrc] NRC NO REGISTRADO", observaciones: ["Revise el NRC"] };

describe("DTE (fulfillment phase 4, ADR-015)", () =>
{
	let tenant: TestTenant;
	let other: TestTenant;
	let company: string;
	let consumer: string;
	let productId: string;
	const anon = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
		auth: { autoRefreshToken: false, persistSession: false },
	});

	beforeAll(async () =>
	{
		[tenant, other] = await Promise.all([setupTenant(), setupTenant()]);
		for (const t of [tenant, other])
		{
			expect((await t.service.from("tenant_order_settings")
				.update({ require_signature: false, require_receiver_name: false }).eq("tenant_id", t.tenantId)).error).toBeNull();
		}
		const [{ data: c1 }, { data: c2 }, { data: p }] = await Promise.all([
			quickAddCustomer(tenant.admin, "Hotel Sol"),
			quickAddCustomer(tenant.admin, "Juan Consumidor"),
			quickAddProduct(tenant.admin, "Cloro", { pricePerUnit: 10, unit: "gal" }),
		]);
		company = c1!.id;
		consumer = c2!.id;
		productId = p!.id;
		const { error } = await tenant.admin.rpc("save_customers", { p_rows: [{
			id: company, name: "Hotel Sol", updated_at: c1!.updated_at, legal_name: "Hoteles del Sol, S.A. de C.V.",
			tax_id: "0614-020290-102-3", nrc: "765-4", cod_actividad: "55101", desc_actividad: "Actividades de alojamiento",
			department_code: "05", municipality_code: "27", district_code: "08", address: "Playa El Tunco", email: "compras@hotelsol.com",
		}] });
		expect(error).toBeNull();

		expect((await tenant.admin.rpc("set_dte_credentials", {
			p_certificate: testCertificate(), p_key_password: KEY_PASSWORD, p_api_password: "api-pass",
		})).error).toBeNull();
		const { error: fiscalError } = await tenant.admin.rpc("save_company_fiscal", { p_data: {
			nit: "06140101901011", nrc: "123456", legal_name: "Ecología Técnica, S.A. de C.V.", commercial_name: "ECTEC",
			cod_actividad: "46900", desc_actividad: "Venta al por mayor de productos químicos",
			department_code: "06", municipality_code: "23", district_code: "14", address: "Calle El Progreso 123",
			phone: "2222-3333", email: "facturas@ectec.com.sv", dte_enabled: true,
		} });
		expect(fiscalError).toBeNull();
	});

	afterAll(async () =>
	{
		vi.unstubAllGlobals();
		await Promise.all([tenant.teardown(), other.teardown()]);
	});

	async function delivered(t: TestTenant, customerId: string, product = productId)
	{
		const { data, error } = await createOrder(t.admin, { customer_id: customerId, notes: "n", items: [{ product_id: product, quantity: 3 }] });
		expect(error).toBeNull();
		const id = data!.order.id;
		expect((await t.operator.rpc("assign_order", {
			p_order_id: id, p_driver_id: t.driverId, p_delivery_date: "2026-11-10", p_delivery_window: "8–12", p_expected_status: "pending",
		})).error).toBeNull();
		expect((await t.driver.rpc("respond_to_assignment", { p_order_id: id, p_accept: true, p_expected_status: "confirmed" })).error).toBeNull();
		expect((await t.driver.rpc("pick_up_orders", { p_order_ids: [id] })).error).toBeNull();
		const { data: items } = await t.service.from("order_items").select("id").eq("order_id", id);
		expect((await t.driver.rpc("record_delivery", {
			p_delivery_id: crypto.randomUUID(), p_order_id: id, p_outcome: "delivered",
			p_lines: items!.map((i) => ({ order_item_id: i.id, delivered_quantity: 3 })),
			p_receiver_name: "Ana", p_signature_path: null, p_photo_path: null, p_failure_reason: null, p_failure_note: null,
			p_payment_method: "cash", p_amount_collected: 33.9,
		} as never)).error).toBeNull();
		return id;
	}

	async function docOf(orderId: string)
	{
		const { data, error } = await tenant.service.from("dte_documents").select("*").eq("order_id", orderId).order("created_at");
		expect(error).toBeNull();
		return data!;
	}

	async function invoiceStatus(orderId: string)
	{
		return (await tenant.service.from("orders").select("invoice_status").eq("id", orderId).single()).data!.invoice_status;
	}

	it("company data: admin only, validated, DTE can't be enabled without credentials", async () =>
	{
		expect((await tenant.operator.rpc("save_company_fiscal", { p_data: { phone: "2222-4444" } })).error?.code).toBe("42501");
		expect((await tenant.admin.rpc("save_company_fiscal", { p_data: { nit: "123" } })).error?.message).toContain("NIT");
		expect((await tenant.admin.rpc("save_company_fiscal", { p_data: { pos_code: "X1" } })).error?.message).toContain("formato");
		const { error } = await other.admin.rpc("save_company_fiscal", { p_data: { dte_enabled: true } });
		expect(error?.message).toContain("credenciales de Hacienda");
		// tenants keeps no direct write path (no UPDATE policy: the row is untouched).
		await tenant.admin.from("tenants").update({ dte_enabled: false }).eq("id", tenant.tenantId);
		expect((await tenant.service.from("tenants").select("dte_enabled").eq("id", tenant.tenantId).single()).data!.dte_enabled).toBe(true);
	});

	it("credentials: admin writes, nobody but service_role reads them", async () =>
	{
		expect((await tenant.admin.rpc("dte_credentials_status")).data).toMatchObject({ configured: true });
		expect((await tenant.operator.rpc("dte_credentials_status")).data).toBeNull();
		expect((await tenant.operator.rpc("set_dte_credentials", { p_certificate: "", p_key_password: "x", p_api_password: "y" })).error?.code).toBe("42501");
		expect((await tenant.admin.rpc("get_dte_credentials", { p_tenant_id: tenant.tenantId })).error?.code).toBe("42501");
		expect((await tenant.admin.from("tenant_dte_credentials").select("*")).error?.code).toBe("42501");
		const { data } = await tenant.service.rpc("get_dte_credentials", { p_tenant_id: tenant.tenantId });
		expect(data?.[0].api_password).toBe("api-pass");
		// Changing only the API password keeps the rest.
		expect((await tenant.admin.rpc("set_dte_credentials", { p_certificate: null as never, p_key_password: null as never, p_api_password: "api-pass-2" })).error).toBeNull();
		const { data: after } = await tenant.service.rpc("get_dte_credentials", { p_tenant_id: tenant.tenantId });
		expect(after?.[0]).toMatchObject({ api_password: "api-pass-2", key_password: KEY_PASSWORD });
		await tenant.admin.rpc("set_dte_credentials", { p_certificate: null as never, p_key_password: null as never, p_api_password: "api-pass" });
	});

	it("customer location codes are saved and validated", async () =>
	{
		const { data } = await tenant.service.from("customers").select("department_code, municipality_code, district_code").eq("id", company).single();
		expect(data).toEqual({ department_code: "05", municipality_code: "27", district_code: "08" });
		const { data: c } = await tenant.service.from("customers").select("updated_at").eq("id", consumer).single();
		const { error } = await tenant.operator.rpc("save_customers", { p_rows: [{ id: consumer, name: "Juan Consumidor", updated_at: c!.updated_at, district_code: "8" }] });
		expect(error?.message).toContain("ubicación");
	});

	it("delivering queues a DTE; a company without DTE queues nothing", async () =>
	{
		const id = await delivered(tenant, company);
		expect(await docOf(id)).toMatchObject([{ status: "queued", control_number: null }]);
		expect(await invoiceStatus(id)).toBe("pending");

		const { data: p } = await quickAddProduct(other.admin, "Otro", { pricePerUnit: 1, unit: "kg" });
		const { data: c } = await quickAddCustomer(other.admin, "Otro cliente");
		const otherId = await delivered(other, c!.id, p!.id);
		expect((await other.service.from("dte_documents").select("id").eq("order_id", otherId)).data).toEqual([]);
	});

	it("PROCESADO: issued with seal, CCF for a customer with NRC, 'invoice' event and email", async () =>
	{
		const id = await delivered(tenant, company);
		const sent = fakeHacienda(processed);
		await processPendingDtes(tenant.service);

		const [doc] = await docOf(id);
		expect(doc).toMatchObject({ status: "issued", dte_type: "03", environment: "00", reception_seal: SEAL });
		expect(doc.control_number).toMatch(/^DTE-03-M001P001-[0-9]{15}$/);
		const body = sent.find((s) => (s.body as { codigoGeneracion: string }).codigoGeneracion === doc.generation_code)!.body;
		expect(body).toMatchObject({ ambiente: "00", version: 4, tipoDte: "03" });
		expect((body as { documento: string }).documento.split(".")).toHaveLength(3);
		expect(await invoiceStatus(id)).toBe("issued");

		const { data: events } = await tenant.service.from("order_events").select("action").eq("order_id", id).eq("action", "invoice");
		expect(events).toHaveLength(1);
		const { data: mails } = await tenant.service.from("order_notifications").select("kind").eq("order_id", id).eq("kind", "invoice_issued");
		expect(mails).toHaveLength(1);

		// The public representación gráfica reads it by tracking token.
		const { data: o } = await tenant.service.from("orders").select("tracking_token").eq("id", id).single();
		const { data: invoice } = await anon.rpc("get_order_invoice", { p_token: o!.tracking_token });
		expect(invoice).toMatchObject({ status: "issued", reception_seal: SEAL });
	});

	it("Factura (01) for a customer without NRC", async () =>
	{
		const id = await delivered(tenant, consumer);
		fakeHacienda(processed);
		await processPendingDtes(tenant.service);
		expect((await docOf(id))[0]).toMatchObject({ status: "issued", dte_type: "01" });
	});

	it("RECHAZADO: error with Hacienda's message; retry keeps the numbers", async () =>
	{
		const id = await delivered(tenant, company);
		fakeHacienda(rejected);
		await processPendingDtes(tenant.service);
		const [doc] = await docOf(id);
		expect(doc.status).toBe("rejected");
		expect(doc.last_error).toContain("NRC NO REGISTRADO");
		expect(await invoiceStatus(id)).toBe("error");

		expect((await tenant.driver.rpc("retry_dte", { p_order_id: id })).error?.code).toBe("42501");
		expect((await tenant.operator.rpc("retry_dte", { p_order_id: id })).error).toBeNull();
		expect(await invoiceStatus(id)).toBe("pending");
		const [requeued, ...rest] = await docOf(id);
		expect(rest).toEqual([]);
		expect(requeued).toMatchObject({ status: "queued", document: null, control_number: doc.control_number, generation_code: doc.generation_code });

		fakeHacienda(processed);
		await processPendingDtes(tenant.service);
		expect((await docOf(id))[0]).toMatchObject({ status: "issued", control_number: doc.control_number });
		expect((await tenant.operator.rpc("retry_dte", { p_order_id: id })).error?.message).toContain("ya tiene una factura");
	});

	it("Hacienda down: stays queued with the error, same numbers next time", async () =>
	{
		const id = await delivered(tenant, company);
		fakeHacienda("down");
		await processPendingDtes(tenant.service);
		const [doc] = await docOf(id);
		expect(doc).toMatchObject({ status: "queued", attempts: 1 });
		expect(doc.last_error).toContain("Sin respuesta de Hacienda");

		await tenant.service.from("dte_documents").update({ next_attempt_at: new Date(0).toISOString() }).eq("id", doc.id);
		fakeHacienda(processed);
		await processPendingDtes(tenant.service);
		expect((await docOf(id))[0]).toMatchObject({ status: "issued", generation_code: doc.generation_code, attempts: 2 });
	});

	it("missing data: error in Spanish, nothing sent, no number used", async () =>
	{
		const { data: c } = await quickAddCustomer(tenant.admin, "Sin dirección");
		await tenant.service.from("customers").update({ nrc: "999-9" }).eq("id", c!.id);
		const id = await delivered(tenant, c!.id);
		const sent = fakeHacienda(processed);
		await processPendingDtes(tenant.service);
		const [doc] = await docOf(id);
		expect(doc).toMatchObject({ status: "error", control_number: null });
		expect(doc.last_error).toContain("al cliente \"Sin dirección\" le falta");
		expect(sent).toEqual([]);
	});

	it("correlativo: never repeated, even in parallel", async () =>
	{
		const orders = await Promise.all([1, 2, 3, 4, 5].map(async () =>
		{
			const { data } = await createOrder(tenant.admin, { customer_id: consumer, notes: "n", items: [{ product_id: productId, quantity: 1 }] });
			return data!.order.id;
		}));
		const { data: docs } = await tenant.service.from("dte_documents")
			.insert(orders.map((order_id) => ({ tenant_id: tenant.tenantId, order_id }))).select("id");
		const numbered = await Promise.all(docs!.map((d) => tenant.service.rpc("assign_dte_number", { p_doc_id: d.id, p_dte_type: "01" })));
		const numbers = numbered.map((r) => r.data!.control_number);
		expect(new Set(numbers).size).toBe(5);
		// Idempotent: asking again returns the same number.
		const again = await tenant.service.rpc("assign_dte_number", { p_doc_id: docs![0].id, p_dte_type: "01" });
		expect(again.data!.control_number).toBe(numbers[0]);
		await tenant.service.from("dte_documents").delete().in("id", docs!.map((d) => d.id));
	});

	it("dte_documents: read-only for staff, invisible to drivers and other tenants; queue functions service-only", async () =>
	{
		const id = await delivered(tenant, company);
		expect((await tenant.operator.from("dte_documents").select("id").eq("order_id", id)).data).toHaveLength(1);
		expect((await tenant.driver.from("dte_documents").select("id").eq("order_id", id)).data).toHaveLength(0);
		expect((await other.admin.from("dte_documents").select("id").eq("order_id", id)).data).toHaveLength(0);
		expect((await tenant.admin.from("dte_documents").update({ status: "issued" }).eq("order_id", id)).error?.code).toBe("42501");
		expect((await tenant.admin.rpc("claim_dte_documents", { p_limit: 1 })).error?.code).toBe("42501");
		const { data: doc } = await tenant.service.from("dte_documents").select("id").eq("order_id", id).single();
		expect((await tenant.admin.rpc("finish_dte", {
			p_doc_id: doc!.id, p_status: "issued", p_seal: SEAL, p_processed_at: new Date().toISOString(), p_response: {}, p_error: "",
		})).error?.code).toBe("42501");
		await tenant.service.from("dte_documents").delete().eq("id", doc!.id);
	});
});
