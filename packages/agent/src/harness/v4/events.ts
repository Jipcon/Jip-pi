import type { EventListener, Events, HarnessEvent, HarnessEventType, WatchHandle } from "./surface.ts";

type GeneralEventListener = EventListener<HarnessEvent>;

function errorDetails(error: unknown): { error: string; stack?: string } {
	if (error instanceof Error) {
		return error.stack === undefined ? { error: error.message } : { error: error.message, stack: error.stack };
	}
	return { error: String(error) };
}

export class HarnessEventBus implements Events {
	private readonly listeners = new Map<HarnessEventType, Set<GeneralEventListener>>();
	private readonly watchListeners = new Set<(event: HarnessEvent) => void>();

	on<Type extends HarnessEventType>(
		type: Type,
		listener: EventListener<Extract<HarnessEvent, { type: Type }>>,
	): () => void {
		const listeners = this.listeners.get(type) ?? new Set<GeneralEventListener>();
		this.listeners.set(type, listeners);
		const receive: GeneralEventListener = (event) => listener(event as Extract<HarnessEvent, { type: Type }>);
		listeners.add(receive);
		return () => {
			listeners.delete(receive);
			if (listeners.size === 0) this.listeners.delete(type);
		};
	}

	emit(event: HarnessEvent): void {
		const isolated = structuredClone(event);
		for (const listener of this.listeners.get(event.type) ?? []) {
			void Promise.resolve()
				.then(() => listener(structuredClone(isolated)))
				.catch((error: unknown) => {
					if (event.type === "handler_error") return;
					this.emit({
						type: "handler_error",
						kind: "event",
						event: event.type,
						...errorDetails(error),
						...("lane" in event && event.lane !== undefined ? { lane: event.lane } : {}),
					});
				});
		}
		for (const listener of this.watchListeners) listener(structuredClone(isolated));
	}

	watch<Snapshot>(captureSnapshot: () => Snapshot): WatchHandle<Snapshot> {
		let listener: GeneralEventListener | undefined;
		let buffered: HarnessEvent[] = [];
		let subscribed = true;
		const receive = (event: HarnessEvent): void => {
			if (!subscribed) return;
			if (listener === undefined) buffered.push(event);
			else void listener(event);
		};
		this.watchListeners.add(receive);
		const snapshot = structuredClone(captureSnapshot());
		return {
			snapshot,
			start: (nextListener) => {
				if (!subscribed) return;
				while (buffered.length > 0) {
					const pending = buffered;
					buffered = [];
					for (const event of pending) void nextListener(structuredClone(event));
				}
				listener = nextListener;
			},
			unsubscribe: () => {
				subscribed = false;
				this.watchListeners.delete(receive);
				buffered = [];
				listener = undefined;
			},
		};
	}
}
