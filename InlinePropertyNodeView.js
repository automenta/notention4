/**
 * Vanilla JS NodeView for the InlineProperty node.
 * Handles rendering the property pill and the editing input.
 */
export class InlinePropertyNodeView {
    constructor(node, view, getPos, dispatch, ontologyService, coreAPI) { // Added coreAPI
        this.node = node;
        this.view = view;
        this.getPos = getPos;
        this.dispatch = dispatch;
        this.ontologyService = ontologyService;
        this.coreAPI = coreAPI; // Store coreAPI

        this.isEditing = false;
        this._outerDOM = null; // The main container span
        this._innerDOM = null; // The content (display span or input)

        this._buildDOM();
        this.renderDisplay(); // Initial render
    }

    // --- Tiptap NodeView Interface ---

    get dom() {
        return this._outerDOM;
    }

    // Optional: Handle updates from Tiptap state if attributes change externally
    update(node) {
        if (node.type !== this.node.type) {
            return false; // Type changed, redraw completely
        }
        // If attributes changed significantly, re-render display/edit state
        if (JSON.stringify(node.attrs) !== JSON.stringify(this.node.attrs)) {
            this.node = node; // Update internal node reference
            if (this.isEditing) {
                // If editing, maybe update input value if it differs? Complex.
                // For now, let's just re-render display if attributes change externally.
                this.renderDisplay();
                this.isEditing = false;
            } else {
                this.renderDisplay();
            }
        }
        return true; // Handled internally
    }

    // Prevent Tiptap from trying to handle selection inside our node
    ignoreMutation(mutation) {
        // Ignore mutations within the node view, except when we are directly manipulating it
        return !this._outerDOM.contains(mutation.target) || this._outerDOM === mutation.target;
    }

    // Make the node selectable but not editable directly
    selectNode() {
        this._outerDOM.classList.add('ProseMirror-selectednode');
    }

    deselectNode() {
        this._outerDOM.classList.remove('ProseMirror-selectednode');
        // If user clicks away while editing, cancel the edit
        if (this.isEditing) {
            this.stopEditing(false); // false = don't save
        }
    }

    destroy() {
        // Remove event listeners if any were added directly (e.g., outside of renderEdit)
        this._outerDOM = null;
        this._innerDOM = null;
    }

    // --- Custom Logic ---

    _buildDOM() {
        this._outerDOM = document.createElement('span');
        this._outerDOM.classList.add('inline-property-nodeview');
        // Add attributes from the node for styling/identification if needed
        this._outerDOM.dataset.propKey = this.node.attrs.key;
        this._outerDOM.dataset.propId = this.node.attrs.propId;

        // Add click listener to the outer element to start editing
        this._outerDOM.addEventListener('click', (event) => {
            event.stopPropagation();
            event.preventDefault();
            if (!this.isEditing) {
                this.startEditing();
            }
        });

        // Prevent clicks inside from bubbling up further if needed
        this._outerDOM.addEventListener('mousedown', (event) => {
            event.stopPropagation(); // Prevent editor selection changes on internal clicks
        });
    }

    renderDisplay() {
        const {key, value, type} = this.node.attrs;
        const hints = this.ontologyService.getUIHints(key) || {icon: '?', color: '#ccc'};
        // Use the same formatting logic as PropertiesPlugin (could be shared utility)
        const displayValue = this._formatDisplayValue(value, type);

        const displaySpan = document.createElement('span');
        displaySpan.classList.add('inline-property-display');
        displaySpan.style.setProperty('--prop-color', hints.color || '#ccc');
        displaySpan.title = `${key} (${type}) - Click to edit`;

        // Use textContent for safety, or innerHTML if icons are HTML entities/tags
        displaySpan.innerHTML = `
            <span class="property-icon">${hints.icon || '?'}</span>
            <span class="property-key">${key}:</span>
            <span class="property-value">${displayValue}</span>
        `;

        // Replace current inner content
        if (this._innerDOM) {
            this._innerDOM.replaceWith(displaySpan);
        } else {
            this._outerDOM.appendChild(displaySpan);
        }
        this._innerDOM = displaySpan;
        this.isEditing = false;
    }

    startEditing() {
        if (this.isEditing) return;
        this.isEditing = true;

        const {key, value, type, propId} = this.node.attrs;
        if (!propId) {
            console.warn("InlinePropertyNodeView: Cannot edit, missing propId attribute.");
            this.isEditing = false;
            return; // Cannot save without propId
        }

        const hints = this.ontologyService.getUIHints(key) || {};
        const inputType = hints.inputType || 'text'; // Get suggested input type

        let inputElement;

        // Create input based on determined type
        if (inputType === 'select' && hints.options) {
            inputElement = document.createElement('select');
            hints.options.forEach(opt => {
                const option = document.createElement('option');
                option.value = opt;
                option.textContent = opt;
                if (opt === value) {
                    option.selected = true;
                }
                inputElement.appendChild(option);
            });
        } else if (inputType === 'textarea') {
            inputElement = document.createElement('textarea');
            inputElement.value = value;
            inputElement.rows = 3; // Example size
        } else if (inputType === 'checkbox') { // Boolean
            inputElement = document.createElement('input');
            inputElement.type = 'checkbox';
            inputElement.checked = this._normalizeValue(value, 'boolean'); // Ensure boolean
            inputElement.style.verticalAlign = 'middle';
        } else if (inputType === 'range') {
            inputElement = document.createElement('input');
            inputElement.type = 'range';
            inputElement.min = hints.min ?? 1;
            inputElement.max = hints.max ?? 10;
            inputElement.step = hints.step ?? 1;
            inputElement.value = this._normalizeValue(value, 'number');
            // Maybe add a span to show the current value next to the range?
        } else { // Default to text-based inputs
            inputElement = document.createElement('input');
            inputElement.type = inputType; // Use hint: 'text', 'number', 'date', 'url', etc.
            // Format value correctly for specific input types
            if (inputType === 'date') {
                try {
                    inputElement.value = value ? new Date(value).toISOString().split('T')[0] : '';
                } catch {
                    inputElement.value = '';
                }
            } else if (inputType === 'datetime-local') {
                try {
                    inputElement.value = value ? new Date(value).toISOString().slice(0, 16) : '';
                } catch {
                    inputElement.value = '';
                }
            } else {
                inputElement.value = value;
            }
            if (inputType === 'number') {
                inputElement.step = hints.step ?? 'any';
            }
        }

        inputElement.classList.add('inline-property-input');
        inputElement.dataset.originalValue = value; // Store original value for comparison

        // --- Event Listeners for Input ---
        inputElement.addEventListener('blur', this.handleBlur.bind(this));
        inputElement.addEventListener('keydown', this.handleKeyDown.bind(this));
        // Save immediately on change for certain types
        if (['checkbox', 'select', 'date', 'range'].includes(inputType)) {
            inputElement.addEventListener('change', () => this.stopEditing(true)); // true = save
        }

        // Replace display span with input
        if (this._innerDOM) {
            this._innerDOM.replaceWith(inputElement);
        } else {
            this._outerDOM.appendChild(inputElement);
        }
        this._innerDOM = inputElement;

        // Clear any previous validation error style
        inputElement.classList.remove('validation-error-inline');

        // Focus and select
        inputElement.focus();
        if (typeof inputElement.select === 'function' && !['checkbox', 'select', 'range'].includes(inputType)) {
            inputElement.select();
        }
    }

    stopEditing(saveChanges = false) {
        if (!this.isEditing) return;

        const inputElement = this._innerDOM;
        if (!inputElement || !inputElement.tagName || ['INPUT', 'SELECT', 'TEXTAREA'].indexOf(inputElement.tagName) === -1) {
            // Not an input, something went wrong, just render display
            this.renderDisplay();
            return;
        }

        if (saveChanges) {
            const {key, type, propId} = this.node.attrs;
            const originalValue = inputElement.dataset.originalValue;
            const newValueRaw = (inputElement.type === 'checkbox') ? inputElement.checked : inputElement.value;
            // Normalize the *new* value based on the property's type before comparing/saving
            const newValueNormalized = this._normalizeValue(newValueRaw, type);

            // Only dispatch if value actually changed
            // --- Validation ---
            const propertiesAPI = this.coreAPI?.getPluginAPI('properties');
            let validationResult = { isValid: true, message: null };
            if (propertiesAPI?._validateValue) {
                validationResult = propertiesAPI._validateValue(key, newValueNormalized, type);
            } else {
                console.warn("InlinePropertyNodeView: Properties API or _validateValue not available for validation.");
            }

            if (!validationResult.isValid) {
                console.warn(`InlinePropertyNodeView: Validation failed for ${key}: ${validationResult.message}`);
                // Add error style and prevent saving/closing
                inputElement.classList.add('validation-error-inline');
                inputElement.title = validationResult.message; // Show error on hover
                // Do NOT switch back to display mode
                // Ensure isEditing remains true
                this.isEditing = true;
                return; // Stop processing here
            }
            // --- End Validation ---

            // Validation passed, remove error style if present
            inputElement.classList.remove('validation-error-inline');
            inputElement.title = ''; // Clear error tooltip

            // Only dispatch if value actually changed
            if (String(originalValue) !== String(newValueNormalized)) {
                console.log(`InlinePropertyNodeView: Saving changes for ${key}: ${originalValue} -> ${newValueNormalized}`);
                this.dispatch({
                    type: 'PROPERTY_UPDATE',
                    payload: {
                        noteId: this._findNoteId(),
                        propertyId: propId,
                        changes: { value: newValueNormalized }
                    }
                });
                // Optimistically update node attribute for smoother UI transition
                this.node.attrs.value = newValueNormalized;
            } else {
                console.log(`InlinePropertyNodeView: No changes detected for ${key}.`);
            }
        } else {
            console.log(`InlinePropertyNodeView: Editing cancelled for ${key}.`);
        }

        // Revert to display mode ONLY if validation passed or saveChanges was false
        this.renderDisplay();
        // isEditing is set to false within renderDisplay
    }

    handleBlur(event) {
        // Use setTimeout to allow related clicks (e.g., if a save button existed)
        setTimeout(() => {
            // Check if focus is still within the nodeview or moved elsewhere
            if (this.isEditing && !this._outerDOM.contains(document.activeElement)) {
                this.stopEditing(true); // Save on blur by default
            }
        }, 100); // Small delay
    }

    handleKeyDown(event) {
        switch (event.key) {
            case 'Enter':
                // For single-line inputs, save and stop editing
                if (event.target.tagName !== 'TEXTAREA' || event.metaKey || event.ctrlKey) {
                    event.preventDefault();
                    this.stopEditing(true); // true = save
                }
                // Allow Enter in textarea unless Ctrl/Meta is pressed
                break;
            case 'Escape':
                event.preventDefault();
                this.stopEditing(false); // false = cancel
                // Restore focus to the main editor view
                this.view.focus();
                break;
        }
        // Allow other keys to propagate for typing
    }

    // Helper to find the note ID (this is a bit hacky, relies on editor structure)
    // A better way might be to store noteId as a node attribute if possible,
    // or pass it down through editor props more explicitly.
    _findNoteId() {
        // Find the closest ancestor element with a data-note-id attribute
        let currentElement = this._outerDOM;
        while (currentElement && !currentElement.dataset.noteId) {
            currentElement = currentElement.parentElement;
        }
        return currentElement?.dataset.noteId || null;
    }

    // --- Formatting/Normalization Helpers (copied/adapted from PropertiesPlugin) ---
    _normalizeValue(value, type) {
        if (value === null || value === undefined) return value;
        switch (type) {
            case 'number':
                const num = Number(value);
                return isNaN(num) ? value : num;
            case 'boolean':
                if (typeof value === 'boolean') return value;
                const lowerVal = String(value).toLowerCase();
                if (['true', 'yes', '1', 'on'].includes(lowerVal)) return true;
                if (['false', 'no', '0', 'off'].includes(lowerVal)) return false;
                return Boolean(value);
            case 'date':
                return value; // Keep as string for now
            case 'list':
                if (typeof value === 'string') return value.split(',').map(s => s.trim()).filter(s => s);
                return Array.isArray(value) ? value : [value];
            case 'text':
            default:
                return String(value);
        }
    }

    _formatDisplayValue(value, type) {
        if (value === null || value === undefined) return '';
        switch (type) {
            case 'boolean':
                return value ? 'Yes' : 'No';
            case 'date':
                try {
                    const date = new Date(value);
                    if (!isNaN(date.getTime())) return date.toLocaleDateString(); // Simpler format
                } catch {
                }
                return String(value);
            case 'list':
                return Array.isArray(value) ? value.join(', ') : String(value);
            default:
                return String(value);
        }
    }

    // Add CSS for validation error
    static injectCSS() {
        const styleId = 'inline-property-validation-style';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .inline-property-input.validation-error-inline {
                    border: 1px solid var(--danger-color, red) !important;
                    outline: 1px solid var(--danger-color, red) !important;
                    background-color: var(--danger-background-muted, #ffe0e0);
                }
            `;
            document.head.appendChild(style);
        }
    }
}

// Inject CSS when the class is loaded
InlinePropertyNodeView.injectCSS();
