import { beforeEach, describe, expect, it, vi } from "vitest";

// BotID can only classify a real request on Vercel, so the verdict is mocked:
// what's tested is that a "bot" verdict stops both forms BEFORE GoTrue is
// called (each sign-in spends the rate-limit bucket every user shares).
const verdict = { isBot: false };
vi.mock("botid/server", () => ({ checkBotId: async () => ({ ...verdict, isHuman: !verdict.isBot }) }));
vi.mock("server-only", () => ({}));

const signInWithPassword = vi.fn(async () => ({ data: { user: null }, error: { message: "invalid" } }));
const updateUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
	createClient: async () => ({
		auth: {
			signInWithPassword,
			updateUser,
			getUser: async () => ({ data: { user: { id: "u1", email: "a@test.local", app_metadata: {} } } }),
		},
	}),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { signInWithPassword, signOut: vi.fn() } }) }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`REDIRECT ${url}`); } }));

const { login, changePassword } = await import("@/lib/auth/actions");

function form(fields: Record<string, string>): FormData
{
	const data = new FormData();
	for (const [k, v] of Object.entries(fields)) data.set(k, v);
	return data;
}

describe("BotID gate on the forms that call GoTrue sign-in", () =>
{
	beforeEach(() =>
	{
		signInWithPassword.mockClear();
		updateUser.mockClear();
	});

	it("login: a bot gets an error and never reaches GoTrue", async () =>
	{
		verdict.isBot = true;
		const result = await login({ error: null }, form({ email: "a@test.local", password: "x" }));
		expect(result.error).toMatch(/verificar tu navegador/);
		expect(signInWithPassword).not.toHaveBeenCalled();
	});

	it("login: a human goes on to GoTrue as before", async () =>
	{
		verdict.isBot = false;
		const result = await login({ error: null }, form({ email: "a@test.local", password: "x" }));
		expect(result.error).toBe("Correo o contraseña incorrectos.");
		expect(signInWithPassword).toHaveBeenCalledTimes(1);
	});

	it("changePassword: a bot can't use the current-password probe either", async () =>
	{
		verdict.isBot = true;
		const result = await changePassword({ error: null }, form({ password: "Nueva-Clave-2026!", confirm: "Nueva-Clave-2026!", current: "x" }));
		expect(result.error).toMatch(/verificar tu navegador/);
		expect(signInWithPassword).not.toHaveBeenCalled();
		expect(updateUser).not.toHaveBeenCalled();
	});
});
