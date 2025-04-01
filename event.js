"use strict";

/** Event Bus */
export class EventBus {
    /** Map<eventType, Set<handler>> */
    _listeners = new Map();

    subscribe(event, handler) {
        if (typeof handler !== 'function') {
            console.error(`EventBus: Listener for event [${event}] is not a function.`);
            return () => {
            }; // Return no-op unsubscribe
        }
        let l = this._listeners;
        if (!l.has(event))
            l.set(event, new Set());

        l.get(event).add(handler);
        // Return unsubscribe function
        return () => {
            if (l.has(event)) {
                l.get(event).delete(handler);
                if (l.get(event).size === 0)
                    l.delete(event);
            }
        };
    }

    publish(event, x) {
        const handlers = this._listeners.get(event);
        if (handlers && handlers.size > 0) {
            // Iterate over a copy in case a handler unsubscribes during the loop
            [...handlers].forEach(handler => {
                try {
                    handler(x);
                } catch (error) {
                    console.error(`EventBus: Error in listener for event [${event}]`, error);
                }
            });
        }
    }
}
