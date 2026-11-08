import { describe, expect, it } from "vitest";
import { detailActions, eventLabel, pendingLines, pendingNote, reasonLabel } from "@/lib/orders/detail";
import { DEFAULT_STATUSES } from "@/lib/orders/board";

const by = (key: string) => DEFAULT_STATUSES.find((s) => s.key === key);

describe("detailActions", () =>
{
	it("offers reassign only before pickup and reprogram only after a failure", () =>
	{
		expect(detailActions(by("confirmed"), false)).toMatchObject({ reassign: true, reprogram: false, cancel: true, correct: false });
		expect(detailActions(by("delivery_failed"), false)).toMatchObject({ reassign: false, reprogram: true, cancel: true });
		expect(detailActions(by("pending"), false)).toMatchObject({ reassign: false, cancel: true });
	});

	it("blocks cancelling once on the road or closed, and only admins correct", () =>
	{
		expect(detailActions(by("dispatched"), true)).toMatchObject({ cancel: false, correct: true });
		expect(detailActions(by("delivered"), false).cancel).toBe(false);
		expect(detailActions(by("partially_delivered"), false).createPending).toBe(true);
		expect(detailActions(undefined, false).cancel).toBe(false);
	});
});

describe("pendingLines", () =>
{
	it("keeps only what is still owed", () =>
	{
		expect(pendingLines([
			{ productId: "a", quantity: 10, deliveredQuantity: 6 },
			{ productId: "b", quantity: 5, deliveredQuantity: 5 },
			{ productId: "c", quantity: 3, deliveredQuantity: 0 },
			{ productId: "d", quantity: 2, deliveredQuantity: null },
		])).toEqual([{ productId: "a", quantity: 4 }, { productId: "c", quantity: 3 }]);
	});
});

describe("labels", () =>
{
	it("formats the note date in local time", () =>
	{
		expect(pendingNote(new Date(2026, 10, 4, 12).toISOString())).toBe("Pendiente del pedido del 04/11/2026");
	});

	it("names events and reasons, passing unknown ones through", () =>
	{
		expect(eventLabel("fail")).toBe("Entrega fallida");
		expect(eventLabel("zzz")).toBe("zzz");
		expect(reasonLabel("wrong_address")).toBe("Dirección incorrecta");
		expect(reasonLabel("Se registró mal")).toBe("Se registró mal");
	});
});
