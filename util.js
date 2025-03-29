import DOMPurify from 'dompurify';

// --- 1. Core Utilities (Utils) ---
export const Utils = {
    generateUUID: () => {
        if (typeof crypto !== 'undefined' && crypto.randomUUID)
            return crypto.randomUUID();

        // Basic fallback (consider a more robust polyfill if needed)
        console.warn("Utils.generateUUID: crypto.randomUUID not available, using fallback.");
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    },

    debounce: (func, wait) => {
        let timeout;
        const cancel = () => clearTimeout(timeout);
        let e = function(...args) {
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
                lastFunc = setTimeout(function () {
                    if ((Date.now() - lastRan) >= limit) {
                        func.apply(context, args);
                        lastRan = Date.now();
                    }
                }, limit - (Date.now() - lastRan));
            }
        }
    },

    sanitizeHTML: (dirtyHTMLString) => {
        if (typeof DOMPurify === 'undefined') {
            console.error("Utils.sanitizeHTML: DOMPurify library is not loaded! Cannot sanitize HTML. Blocking potentially unsafe content.");
            // In a real app, you might throw an error or display a clear warning to the user.
            // Returning an empty string or placeholder is safer than returning unsanitized content.
            return "[HTML Sanitization Unavailable]";
            // throw new Error("DOMPurify is required for HTML sanitization but not loaded.");
        }
        // Configure DOMPurify as needed (e.g., allow specific tags/attributes)
        // Default configuration is generally safe.
        return DOMPurify.sanitize(dirtyHTMLString);
    },

    formatDate: (timestamp) => {
        if (!timestamp) return '';
        try {
            // Use Intl for better localization and formatting options
            return new Intl.DateTimeFormat(undefined, {
                dateStyle: 'short', // e.g., '12/19/2023'
                timeStyle: 'short'  // e.g., '3:30 PM'
            }).format(new Date(timestamp));
        } catch (e) {
            console.warn("Utils.formatDate: Error formatting date", e);
            return new Date(timestamp).toLocaleString(); // Fallback
        }
    },

    // deepClone is generally not needed with Immer managing state.
    // If required elsewhere, prefer structuredClone where available.
    // deepClone: (obj) => structuredClone(obj), // Use modern API if needed
};
