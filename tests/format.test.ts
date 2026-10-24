import { describe, expect, it } from "vitest";
import { formatChannel, formatOrderTimestamp } from "@/lib/format";

describe("formatOrderTimestamp", () =>
{
	it("pads single-digit day/month/hour/minute/second to 2 digits", () =>
	{
		const d = new Date(2026, 0, 5, 9, 3, 7); // 5 Jan 2026, 09:03:07 local
		expect(formatOrderTimestamp(d.toISOString())).toBe("05-01-2026 09:03:07");
	});

	it("does not pad double-digit components", () =>
	{
		const d = new Date(2026, 11, 25, 23, 59, 59); // 25 Dec 2026, 23:59:59 local
		expect(formatOrderTimestamp(d.toISOString())).toBe("25-12-2026 23:59:59");
	});
});

describe("formatChannel", () =>
{
	it("maps known channels to their display label", () =>
	{
		expect(formatChannel("whatsapp")).toBe("WhatsApp");
		expect(formatChannel("portal")).toBe("Portal");
	});

	it("falls back to the raw value for an unrecognized channel", () =>
	{
		expect(formatChannel("carrier-pigeon")).toBe("carrier-pigeon");
	});
});
