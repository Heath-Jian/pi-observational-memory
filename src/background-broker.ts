export interface BackgroundLease {
	signal: AbortSignal;
	waitedMs: number;
	release: () => void;
}

export interface BackgroundRequest {
	owner: string;
	priority: number;
	signal?: AbortSignal;
}

interface QueueItem extends BackgroundRequest {
	enqueuedAt: number;
	controller: AbortController;
	resolve: (lease: BackgroundLease) => void;
	reject: (error: Error) => void;
	onExternalAbort?: () => void;
}

interface BrokerSnapshot {
	foregroundActive: boolean;
	activeOwner?: string;
	queuedOwners: string[];
}

const BROKER_SYMBOL = Symbol.for("pi.context.background-broker.v1");

export class BackgroundBroker {
	private foregroundActive = false;
	private active?: QueueItem;
	private queue: QueueItem[] = [];
	private drainScheduled = false;

	setForegroundActive(active: boolean, reason = "foreground activity"): void {
		this.foregroundActive = active;
		if (active) this.active?.controller.abort(reason);
		this.scheduleDrain();
	}

	acquire(request: BackgroundRequest): Promise<BackgroundLease> {
		if (request.signal?.aborted) return Promise.reject(new Error(String(request.signal.reason ?? "aborted")));
		return new Promise((resolve, reject) => {
			const item: QueueItem = {
				...request,
				enqueuedAt: Date.now(),
				controller: new AbortController(),
				resolve,
				reject,
			};
			if (request.signal) {
				item.onExternalAbort = () => {
					item.controller.abort(request.signal?.reason ?? "aborted");
					if (this.active === item) return;
					this.queue = this.queue.filter((candidate) => candidate !== item);
					reject(new Error(String(request.signal?.reason ?? "aborted")));
				};
				request.signal.addEventListener("abort", item.onExternalAbort, { once: true });
			}
			this.queue.push(item);
			this.queue.sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt);
			this.scheduleDrain();
		});
	}

	snapshot(): BrokerSnapshot {
		return {
			foregroundActive: this.foregroundActive,
			activeOwner: this.active?.owner,
			queuedOwners: this.queue.map((item) => item.owner),
		};
	}

	private scheduleDrain(): void {
		if (this.drainScheduled) return;
		this.drainScheduled = true;
		queueMicrotask(() => {
			this.drainScheduled = false;
			this.drain();
		});
	}

	private drain(): void {
		if (this.foregroundActive || this.active) return;
		const item = this.queue.shift();
		if (!item) return;
		if (item.signal?.aborted) {
			item.reject(new Error(String(item.signal.reason ?? "aborted")));
			this.scheduleDrain();
			return;
		}
		this.active = item;
		let released = false;
		item.resolve({
			signal: item.controller.signal,
			waitedMs: Date.now() - item.enqueuedAt,
			release: () => {
				if (released) return;
				released = true;
				if (item.signal && item.onExternalAbort) item.signal.removeEventListener("abort", item.onExternalAbort);
				if (this.active === item) this.active = undefined;
				this.scheduleDrain();
			},
		});
	}
}

type GlobalWithBroker = typeof globalThis & { [BROKER_SYMBOL]?: BackgroundBroker };

export function getBackgroundBroker(): BackgroundBroker {
	const shared = globalThis as GlobalWithBroker;
	shared[BROKER_SYMBOL] ??= new BackgroundBroker();
	return shared[BROKER_SYMBOL];
}

export async function withBackgroundLease<T>(
	request: BackgroundRequest,
	work: (signal: AbortSignal, waitedMs: number) => Promise<T>,
): Promise<T> {
	const lease = await getBackgroundBroker().acquire(request);
	try {
		return await work(lease.signal, lease.waitedMs);
	} finally {
		lease.release();
	}
}
