import type { AgentMessage } from "../../types.ts";
import type { JsonValue, SettledAssistantMessage } from "./base.ts";
import type { HarnessEventBus } from "./events.ts";
import type { HookHandler, HookInvocation, HookMap, HookName, Hooks } from "./surface.ts";

interface RegisteredHook {
	id?: string;
	handler: (event: HookInvocation<HookName>) => Promise<unknown> | unknown;
}

interface BeforeRunAggregate {
	messages: AgentMessage[];
	systemPrompt?: string;
	resumeData: Record<string, JsonValue>;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown): string | undefined {
	return error instanceof Error ? error.stack : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class HarnessHookRegistry implements Hooks {
	private readonly handlers = new Map<HookName, RegisteredHook[]>();
	private readonly events: HarnessEventBus;

	constructor(events: HarnessEventBus) {
		this.events = events;
	}

	has(name: HookName): boolean {
		return (this.handlers.get(name)?.length ?? 0) > 0;
	}

	on<Name extends HookName>(name: Name, handler: HookHandler<Name>, options: { id?: string } = {}): () => void {
		if ((name === "before_run" || name === "before_resume") && options.id === undefined) {
			throw new Error(`${name} hooks require a stable id`);
		}
		const existing = this.handlers.get(name) ?? [];
		if (options.id !== undefined && existing.some((registered) => registered.id === options.id)) {
			throw new Error(`Duplicate ${name} hook id ${options.id}`);
		}
		const registered: RegisteredHook = {
			...(options.id === undefined ? {} : { id: options.id }),
			handler: handler as RegisteredHook["handler"],
		};
		existing.push(registered);
		this.handlers.set(name, existing);
		return () => {
			const index = existing.indexOf(registered);
			if (index >= 0) existing.splice(index, 1);
			if (existing.length === 0) this.handlers.delete(name);
		};
	}

	private handlerError(name: HookName, invocation: HookInvocation<HookName>, error: unknown): void {
		const stack = errorStack(error);
		this.events.emit({
			type: "handler_error",
			kind: "hook",
			hook: name,
			error: errorMessage(error),
			...(stack === undefined ? {} : { stack }),
			lane: invocation.lane,
		});
	}

	private async invoke(
		name: HookName,
		registered: RegisteredHook,
		invocation: HookInvocation<HookName>,
	): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
		try {
			return { ok: true, value: await registered.handler(structuredClone(invocation)) };
		} catch (error) {
			this.handlerError(name, invocation, error);
			return { ok: false, error };
		}
	}

	async run<Name extends HookName>(name: Name, invocation: HookInvocation<Name>): Promise<HookMap[Name]["result"]> {
		const handlers = this.handlers.get(name) ?? [];
		switch (name) {
			case "before_run":
				return (await this.runBeforeRun(
					handlers,
					invocation as HookInvocation<"before_run">,
				)) as HookMap[Name]["result"];
			case "before_resume":
				await this.runBeforeResume(handlers, invocation as HookInvocation<"before_resume">);
				return undefined as HookMap[Name]["result"];
			case "before_run_end":
				return (await this.runBeforeRunEnd(
					handlers,
					invocation as HookInvocation<"before_run_end">,
				)) as HookMap[Name]["result"];
			case "transform_context":
				return (await this.runTransformContext(
					handlers,
					invocation as HookInvocation<"transform_context">,
				)) as HookMap[Name]["result"];
			case "before_request":
				return (await this.runPatchHook(name, handlers, invocation)) as HookMap[Name]["result"];
			case "before_payload":
				return (await this.runReplaceHook(name, handlers, invocation, "payload")) as HookMap[Name]["result"];
			case "after_response":
				return (await this.runAfterResponse(
					handlers,
					invocation as HookInvocation<"after_response">,
				)) as HookMap[Name]["result"];
			case "before_tool":
				return (await this.runBeforeTool(
					handlers,
					invocation as HookInvocation<"before_tool">,
				)) as HookMap[Name]["result"];
			case "after_tool":
				return (await this.runPatchHook(name, handlers, invocation)) as HookMap[Name]["result"];
			case "before_compaction":
				return (await this.runDecisionHook(name, handlers, invocation, "compaction")) as HookMap[Name]["result"];
			case "before_navigation":
				return (await this.runDecisionHook(name, handlers, invocation, "summary")) as HookMap[Name]["result"];
		}
	}

	private async runBeforeRun(
		handlers: RegisteredHook[],
		invocation: HookInvocation<"before_run">,
	): Promise<HookMap["before_run"]["result"]> {
		const aggregate: BeforeRunAggregate = { messages: [], systemPrompt: invocation.systemPrompt, resumeData: {} };
		const current = structuredClone(invocation);
		for (const registered of handlers) {
			const outcome = await this.invoke("before_run", registered, current);
			if (!outcome.ok || outcome.value === undefined || !isRecord(outcome.value)) continue;
			const messages = Array.isArray(outcome.value.messages) ? (outcome.value.messages as AgentMessage[]) : [];
			aggregate.messages.push(...structuredClone(messages));
			current.prompt.push(...structuredClone(messages));
			if (typeof outcome.value.systemPrompt === "string") {
				aggregate.systemPrompt = outcome.value.systemPrompt;
				current.systemPrompt = outcome.value.systemPrompt;
			}
			if (outcome.value.resumeData !== undefined && registered.id !== undefined) {
				aggregate.resumeData[registered.id] = structuredClone(outcome.value.resumeData as JsonValue);
			}
		}
		if (
			aggregate.messages.length === 0 &&
			aggregate.systemPrompt === invocation.systemPrompt &&
			Object.keys(aggregate.resumeData).length === 0
		) {
			return undefined;
		}
		return {
			...(aggregate.messages.length === 0 ? {} : { messages: aggregate.messages }),
			...(aggregate.systemPrompt === invocation.systemPrompt ? {} : { systemPrompt: aggregate.systemPrompt }),
			...(Object.keys(aggregate.resumeData).length === 0 ? {} : { resumeData: aggregate.resumeData }),
		};
	}

	private async runBeforeResume(
		handlers: RegisteredHook[],
		invocation: HookInvocation<"before_resume">,
	): Promise<void> {
		const resumeData = isRecord(invocation.resumeData) ? invocation.resumeData : {};
		for (const registered of handlers) {
			await this.invoke("before_resume", registered, {
				...invocation,
				...(registered.id === undefined || resumeData[registered.id] === undefined
					? { resumeData: undefined }
					: { resumeData: resumeData[registered.id] as JsonValue }),
			});
		}
	}

	private async runBeforeRunEnd(
		handlers: RegisteredHook[],
		invocation: HookInvocation<"before_run_end">,
	): Promise<HookMap["before_run_end"]["result"]> {
		let followUp: string | undefined;
		for (const registered of handlers) {
			const outcome = await this.invoke("before_run_end", registered, invocation);
			if (outcome.ok && isRecord(outcome.value) && typeof outcome.value.followUp === "string") {
				followUp = outcome.value.followUp;
			}
		}
		return followUp === undefined ? undefined : { followUp };
	}

	private async runTransformContext(
		handlers: RegisteredHook[],
		invocation: HookInvocation<"transform_context">,
	): Promise<HookMap["transform_context"]["result"]> {
		let messages = structuredClone(invocation.messages);
		let changed = false;
		for (const registered of handlers) {
			const outcome = await this.invoke("transform_context", registered, { ...invocation, messages });
			if (outcome.ok && isRecord(outcome.value) && Array.isArray(outcome.value.messages)) {
				messages = structuredClone(outcome.value.messages as AgentMessage[]);
				changed = true;
			}
		}
		return changed ? { messages } : undefined;
	}

	private async runPatchHook(
		name: "before_request" | "after_tool",
		handlers: RegisteredHook[],
		invocation: HookInvocation<HookName>,
	): Promise<Record<string, unknown> | undefined> {
		let current = structuredClone(invocation) as HookInvocation<HookName> & Record<string, unknown>;
		let aggregate: Record<string, unknown> | undefined;
		for (const registered of handlers) {
			const outcome = await this.invoke(name, registered, current);
			if (!outcome.ok || !isRecord(outcome.value)) continue;
			aggregate = { ...(aggregate ?? {}), ...structuredClone(outcome.value) };
			current = { ...current, ...structuredClone(outcome.value) };
		}
		return aggregate;
	}

	private async runReplaceHook(
		name: "before_payload",
		handlers: RegisteredHook[],
		invocation: HookInvocation<HookName>,
		field: "payload",
	): Promise<Record<string, unknown> | undefined> {
		let current = structuredClone(invocation) as HookInvocation<HookName> & Record<string, unknown>;
		let changed = false;
		for (const registered of handlers) {
			const outcome = await this.invoke(name, registered, current);
			if (!outcome.ok || !isRecord(outcome.value) || !(field in outcome.value)) continue;
			current = { ...current, [field]: structuredClone(outcome.value[field]) };
			changed = true;
		}
		return changed ? { [field]: current[field] } : undefined;
	}

	private async runAfterResponse(
		handlers: RegisteredHook[],
		invocation: HookInvocation<"after_response">,
	): Promise<HookMap["after_response"]["result"]> {
		let message = structuredClone(invocation.message);
		let changed = false;
		for (const registered of handlers) {
			const outcome = await this.invoke("after_response", registered, { ...invocation, message });
			if (!outcome.ok || !isRecord(outcome.value) || outcome.value.message === undefined) continue;
			const next = outcome.value.message as SettledAssistantMessage;
			if (next.role !== "assistant") {
				this.handlerError("after_response", invocation, new Error("after_response must preserve assistant role"));
				continue;
			}
			message = structuredClone(next);
			changed = true;
		}
		return changed ? { message } : undefined;
	}

	private async runBeforeTool(
		handlers: RegisteredHook[],
		invocation: HookInvocation<"before_tool">,
	): Promise<HookMap["before_tool"]["result"]> {
		let args = structuredClone(invocation.args);
		let changed = false;
		for (const registered of handlers) {
			const outcome = await this.invoke("before_tool", registered, { ...invocation, args });
			if (!outcome.ok) return { block: { reason: errorMessage(outcome.error) } };
			if (!isRecord(outcome.value)) continue;
			if (outcome.value.args !== undefined && isRecord(outcome.value.args)) {
				args = structuredClone(outcome.value.args) as Record<string, JsonValue>;
				changed = true;
			}
			if (isRecord(outcome.value.block) && typeof outcome.value.block.reason === "string") {
				return {
					...(changed ? { args } : {}),
					block: {
						reason: outcome.value.block.reason,
						...(outcome.value.block.terminate === true ? { terminate: true } : {}),
					},
				};
			}
		}
		return changed ? { args } : undefined;
	}

	private async runDecisionHook(
		name: "before_compaction" | "before_navigation",
		handlers: RegisteredHook[],
		invocation: HookInvocation<HookName>,
		resultField: "compaction" | "summary",
	): Promise<Record<string, unknown> | undefined> {
		for (const registered of handlers) {
			const outcome = await this.invoke(name, registered, invocation);
			if (!outcome.ok || !isRecord(outcome.value)) continue;
			if (outcome.value.decline === true && outcome.value[resultField] !== undefined) {
				this.handlerError(name, invocation, new Error(`${name} cannot return decline and ${resultField}`));
				continue;
			}
			if (outcome.value.decline === true) return { decline: true };
			if (outcome.value[resultField] !== undefined) return { [resultField]: outcome.value[resultField] };
		}
		return undefined;
	}
}
