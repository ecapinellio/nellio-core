import { describe, expect, it } from "vitest";
import { DEFAULT_STATUSES, boardColumns, cardNotes, groupOrdersByColumn, keepSnapshot, snapshotForAssign, localDateString, statusColor } from "@/lib/orders/board";

const now = new Date("2026-11-05T12:00:00Z");
const def = (key: string) => DEFAULT_STATUSES.find((s) => s.key === key)!;

describe("boardColumns / groupOrdersByColumn", () =>
{
	it("orders by position and leaves cancelled out", () =>
	{
		const cols = boardColumns([...DEFAULT_STATUSES].reverse());
		expect(cols.map((c) => c.key)).toEqual(["pending", "confirmed", "accepted", "dispatched", "delivery_failed", "delivered", "partially_delivered"]);
	});

	it("buckets by status key and drops unknown ones", () =>
	{
		const cols = boardColumns(DEFAULT_STATUSES);
		const groups = groupOrdersByColumn([{ status: "pending" }, { status: "cancelled" }, { status: "pending" }, { status: "nope" }], cols);
		expect(groups.pending).toHaveLength(2);
		expect(groups.cancelled).toBeUndefined();
		expect(groups.delivered).toEqual([]);
	});
});

describe("statusColor", () =>
{
	it("follows the category, with own marks for failed and partial", () =>
	{
		expect(statusColor(def("pending"))).toBe("var(--status-pending)");
		expect(statusColor(def("accepted"))).toBe("var(--status-confirmed)");
		expect(statusColor(def("dispatched"))).toBe("var(--status-dispatched)");
		expect(statusColor(def("delivered"))).toBe("var(--status-delivered)");
		expect(statusColor(def("delivery_failed"))).toBe("var(--destructive)");
		expect(statusColor(def("partially_delivered"))).toBe("var(--status-pending)");
	});
});

describe("cardNotes", () =>
{
	const base = { driverName: "Ana", statusChangedAt: "2026-11-05T10:30:00Z", attempt: 0 };

	it("flags an unanswered assignment from one hour on, in whole hours", () =>
	{
		expect(cardNotes(base, def("confirmed"), now).unacceptedHours).toBe(1);
		expect(cardNotes({ ...base, statusChangedAt: "2026-11-05T11:30:00Z" }, def("confirmed"), now).unacceptedHours).toBeNull();
		expect(cardNotes(base, def("accepted"), now).unacceptedHours).toBeNull();
	});

	it("flags a confirmed order nobody holds", () =>
	{
		expect(cardNotes({ ...base, driverName: null }, def("confirmed"), now)).toMatchObject({ noDriver: true, unacceptedHours: null });
	});

	it("shows the attempt from the second on, and the failure", () =>
	{
		expect(cardNotes({ ...base, attempt: 1 }, def("dispatched"), now).attempt).toBeNull();
		expect(cardNotes({ ...base, attempt: 2 }, def("dispatched"), now).attempt).toBe(2);
		expect(cardNotes(base, def("delivery_failed"), now).failed).toBe(true);
	});
});

describe("localDateString", () =>
{
	it("uses the local calendar day, zero padded", () =>
	{
		expect(localDateString(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
	});
});

describe("assign snapshot", () =>
{
	const order = { id: "a", status: "pending", customerName: "C", deliveryDate: null, deliveryWindow: null };

	it("freezes the status seen at open, whatever the board does later", () =>
	{
		const snap = snapshotForAssign([order], "a")!;
		const refetched = [{ ...order, status: "confirmed" }];
		expect(keepSnapshot(snap, refetched)?.status).toBe("pending");
	});

	it("drops the snapshot when the order leaves the board, and for unknown ids", () =>
	{
		const snap = snapshotForAssign([order], "a");
		expect(keepSnapshot(snap, [])).toBeNull();
		expect(snapshotForAssign([order], "zzz")).toBeNull();
	});
});
