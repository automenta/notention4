// --- 2. Core Event Bus ---
export class EventBus {
    _listeners = new WeakMap(); // WeakMap<eventType, Set<handler>> //TODO WeakMap?

    subscribe(eventType, handler) {
        if (typeof handler !== 'function') {
            console.error(`EventBus: Listener for event [${eventType}] is not a function.`);
            return () => {
            }; // Return no-op unsubscribe
        }
        if (!this._listeners.has(eventType))
            this._listeners.set(eventType, new Set());

        this._listeners.get(eventType).add(handler);
        // Return unsubscribe function
        return () => {
            if (this._listeners.has(eventType)) {
                this._listeners.get(eventType).delete(handler);
                if (this._listeners.get(eventType).size === 0)
                    this._listeners.delete(eventType);
            }
        };
    }

    publish(eventType, payload) {
        const handlers = this._listeners.get(eventType);
        if (handlers && handlers.size > 0) {
            // Iterate over a copy in case a handler unsubscribes during the loop
            [...handlers].forEach(handler => {
                try {
                    handler(payload);
                } catch (error) {
                    console.error(`EventBus: Error in listener for event [${eventType}]`, error);
                }
            });
        }
    }
}
