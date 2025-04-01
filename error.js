window.onerror = function (message, source, lineno, colno, error) {
    console.error("Unhandled Global Error:", message, source, `line ${lineno}:${colno}`, error);
    const appRoot = document.getElementById('app');
    if (appRoot) {
        // Use DOMPurify if available, otherwise basic text insertion
        let sanitizedMessage = message;
        let sanitizedStack = error?.stack;
        if (typeof DOMPurify !== 'undefined') {
             sanitizedMessage = DOMPurify.sanitize(message);
             sanitizedStack = error?.stack ? DOMPurify.sanitize(error.stack) : '';
             const errorHtml = `
                    <div class="error-display" style="padding: 20px; border: 2px solid red; background: #fff0f0; color: #333;">
                        <h1>Application Error</h1>
                        <p>An unexpected error occurred. Please check the console for details.</p>
                        <p><strong>Message:</strong> ${sanitizedMessage}</p>
                        ${sanitizedStack ? `<pre style="white-space: pre-wrap; word-wrap: break-word; border: 1px solid #ccc; padding: 10px; background: #f9f9f9;">${sanitizedStack}</pre>` : ''}
                        <p>You may need to reload the application or clear local data using the browser's developer tools (Application -> Local Storage).</p>
                    </div>`;
            // Use SAFE_FOR_TEMPLATES to allow basic structure but sanitize content
             try {
                 appRoot.innerHTML = DOMPurify.sanitize(errorHtml, {USE_PROFILES: {html: true}});
             } catch (sanitizeError) {
                 console.error("Error sanitizing/rendering global error message:", sanitizeError);
                 appRoot.textContent = `Application Error: ${message}. Check console. (Error display failed)`;
             }
        } else {
            // Basic text fallback if DOMPurify is missing
            console.warn("DOMPurify not available for error display.");
            appRoot.textContent = `Application Error: An unexpected error occurred. Please check the browser console for details (${message}). Reloading or clearing data might help.`;
        }
    }
    // Prevent default browser error handling
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
