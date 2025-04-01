"use strict";

import DOMPurify from 'dompurify';

export const Utils = {
    generateUUID: () => {
        if (typeof crypto !== 'undefined' && crypto.randomUUID)
            return crypto.randomUUID();

        console.warn("Utils.generateUUID: crypto.randomUUID not available, using fallback.");
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    },

    debounce: (func, wait) => {
        let timeout;
        const cancel = () => clearTimeout(timeout);
        let e = function (...args) {
            cancel();
            timeout = setTimeout(() => {
                clearTimeout(timeout);
                func.apply(this, args);
            }, wait);
        };
        e.cancel = cancel;
        return e;
    },

    throttle: (func, limit) => {
        let lastFunc, lastRan;
        return function (...args) {
            const context = this;
            if (!lastRan) {
                func.apply(context, args);
                lastRan = Date.now();
            } else {
                clearTimeout(lastFunc);
                lastFunc = setTimeout(() => {
                    if ((Date.now() - lastRan) >= limit) {
                        func.apply(context, args);
                        lastRan = Date.now();
                    }
                }, limit - (Date.now() - lastRan));
            }
        };
    },

    sanitizeHTML: (dirtyHTMLString) => {
        if (typeof DOMPurify === 'undefined') {
            console.error("Utils.sanitizeHTML: DOMPurify library is not loaded! Cannot sanitize HTML. Blocking potentially unsafe content.");
            return "[HTML Sanitization Unavailable]";
        }
        return DOMPurify.sanitize(dirtyHTMLString);
    },

    formatDate: (timestamp) => {
        if (!timestamp) return '';
        try {
            return new Intl.DateTimeFormat(undefined, {
                dateStyle: 'short',
                timeStyle: 'short'
            }).format(new Date(timestamp));
        } catch (e) {
            console.warn("Utils.formatDate: Error formatting date", e);
            return new Date(timestamp).toLocaleString();
        }
    },

    dependencySort(plugins) {
        const graph = new Map();
        const inDegree = new Map();
        const sorted = [];
        const q = [];

        plugins.forEach((entry, plugin) => {
            graph.set(plugin, new Set());
            inDegree.set(plugin, 0);
        });

        plugins.forEach((entry, plugin) => {
            const dependencies = entry.definition.dependencies || [];
            dependencies.forEach(dep => {
                if (!plugins.has(dep))
                    throw new Error(`Plugin [${plugin}] has an unknown dependency: [${dep}]`);

                if (graph.has(dep) && !graph.get(dep).has(plugin)) {
                    graph.get(dep).add(plugin);
                    inDegree.set(plugin, (inDegree.get(plugin) || 0) + 1);
                }
            });
        });

        inDegree.forEach((degree, plugin) => {
            if (degree === 0)
                q.push(plugin);
        });

        while (q.length > 0) {
            const u = q.shift();
            sorted.push(u);

            graph.get(u)?.forEach(v => {
                inDegree.set(v, inDegree.get(v) - 1);
                if (inDegree.get(v) === 0)
                    q.push(v);
            });
        }

        if (sorted.length !== plugins.size)
            throw new Error(`Circular dependency detected involving plugins: ${Array.from(plugins.keys()).filter(id => !sorted.includes(id)).join(', ')}`);

        return sorted;
    }
};
