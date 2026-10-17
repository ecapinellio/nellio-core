// Loads the same .env.local the rest of the app uses (mirrors
// `bootstrap:admin`'s own --env-file pattern — T7, Decision 6). CI sets
// these vars directly in the environment instead of via a file, so a
// missing .env.local there is expected, not an error.
try
{
	process.loadEnvFile(".env.local");
}
catch (error)
{
	if ((error as NodeJS.ErrnoException).code !== "ENOENT")
	{
		throw error;
	}
}
