window.onerror = function (message, source, lineno, colno, error) {
    console.error("Unhandled Global Error:", message, source, `line ${lineno}:${colno}`, error);
    const appRoot = document.getElementById('app');
    if (appRoot) {
        // Use DOMPurify if available, otherwise basic text insertion
        if (typeof DOMPurify !== 'undefined') {
            const errorHtml = `
                    <div class="error-display">
                        <h1>Application Error</h1>
                        <p>An unexpected error occurred. Please check the console for details.</p>
                        <p><strong>Message:</strong> ${message}</p>
                        ${error?.stack ? `<pre>${error.stack}</pre>` : ''}
                        <p>You may need to reload the application or clear local data.</p>
                    </div>`;
            appRoot.innerHTML = DOMPurify.sanitize(errorHtml);
        } else {
            appRoot.textContent = `Application Error: ${message}. Check console.`; // Fallback
        }
    }
    // Prevent default browser error handling
    return true;
};
window.onunhandledrejection = function (event) {
    console.error("Unhandled Promise Rejection:", event.reason);
    // Optionally display a less intrusive error using the status bar if CoreAPI is available
    window.realityNotebookCore?.showGlobalStatus(`Unhandled rejection: ${event.reason?.message || event.reason}`, 'error', 10000);
};