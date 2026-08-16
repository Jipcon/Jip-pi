import type { CommandResult } from "../shared/ipc.ts";

export async function toCommandResult<T>(operation: () => T | Promise<T>): Promise<CommandResult<T>> {
	try {
		const value = await operation();
		return value === undefined ? { ok: true } : { ok: true, value };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
