import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/auth/safe-next";

describe("safeNextPath(): post-login redirect stays inside the app", () =>
{
	it("keeps in-app paths, with their query and hash", () =>
	{
		expect(safeNextPath("/orders")).toBe("/orders");
		expect(safeNextPath("/orders/historial?page=2#top")).toBe("/orders/historial?page=2#top");
		expect(safeNextPath("/")).toBe("/");
	});

	it("rejects anything that would leave the site", () =>
	{
		for (const next of [
			"https://evil.com",
			"//evil.com",
			// Browsers read "\" as "/": these resolve to https://evil.com/.
			"/\\evil.com",
			"/\\/evil.com",
			// Dot segments resolve to "//evil.com".
			"/.//evil.com",
			"/%2e//evil.com",
			"/a/..//evil.com",
			"\\\\evil.com",
			"evil.com",
			"javascript:alert(1)",
		])
		{
			expect(safeNextPath(next), next).toBe("/");
		}
	});

	it("never yields a path a browser would resolve to another origin", () =>
	{
		for (const next of ["/\tevil.com", "/\t/evil.com", "/%5Cevil.com", "/%2F%2Fevil.com", "/\n/evil.com"])
		{
			const result = safeNextPath(next);
			expect(new URL(result, "https://app.example/login").origin, next).toBe("https://app.example");
		}
	});

	it("falls back to / for missing or non-string input", () =>
	{
		expect(safeNextPath(null)).toBe("/");
		expect(safeNextPath(undefined)).toBe("/");
		expect(safeNextPath("")).toBe("/");
	});
});
