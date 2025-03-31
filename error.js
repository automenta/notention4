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
                        <p><strong>Message:</strong> ${DOMPurify.sanitize(message)}</p>
                        ${error?.stack ? `<pre>${DOMPurify.sanitize(error.stack)}</pre>` : ''}
                        <p>You may need to reload the application or clear local data using the browser's developer tools (Application -> Local Storage).</p>
                    </div>`;
            // Use SAFE_FOR_TEMPLATES to allow basic structure but sanitize content
            appRoot.innerHTML = DOMPurify.sanitize(errorHtml, {USE_PROFILES: {html: true}});
        } else {
            // Basic text fallback, avoid inserting raw message directly if possible
            appRoot.textContent = `Application Error: An unexpected error occurred. Please check the browser console for details (${message}). Reloading or clearing data might help.`;
        }
    }
    // Prevent default browser error handling (optional, depends on desired behavior)
    return true;
};
window.onunhandledrejection = function (event) {
    console.error("Unhandled Promise Rejection:", event.reason);
    const reason = event.reason;
    let errorMessage = "An unhandled promise rejection occurred.";
    if (reason instanceof Error) {
        errorMessage = `Unhandled rejection: ${reason.message}`;
    } else if (typeof reason === 'string') {
        errorMessage = `Unhandled rejection: ${reason}`;
    } else {
        errorMessage = `Unhandled rejection: ${JSON.stringify(reason)}`;
    }
    // Display error using status bar if CoreAPI is available and initialized
    window.realityNotebookCore?.showGlobalStatus(errorMessage, 'error', 10000);
    // Optionally add more robust global error display here if needed
};
