/**
 * Rich Text Editor Plugin using Tiptap
 * Replaces a target element with a Tiptap rich text editor.
 */
"use strict";

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { InlineProperty } from './InlineProperty.js'; // Import the new Node

// Ensure lit is imported correctly based on your setup
const { html, render: litRender } = window.lit ?? window.litHtml ?? { html: null, render: null };
if (!html || !litRender) {
    console.error("Lit-html not found. UI rendering will fail.");
    // Provide dummy functions to prevent further errors immediately
    window.litHtml = { html: (strings, ...values) => strings.join(''), render: () => {} };
}


import { Utils } from "./util.js"; const debounce = Utils.debounce;

import { SLOT_EDITOR_CONTENT_AREA } from './ui.js';

// --- Abstract Base Class (Optional but good practice) ---
class AbstractEditorLibrary {
    _element = null;
    _content = '';
    _onSelectionUpdateCallback = null;
    _isUpdatingInternally = false;

    constructor(selectorOrElement, config = {}) {
        if (new.target === AbstractEditorLibrary)
            throw new TypeError("Cannot construct AbstractEditorLibrary instances directly");

        this._element = typeof selectorOrElement === 'string'
            ? document.querySelector(selectorOrElement)
            : selectorOrElement;

        if (!this._element)
            throw new Error(`Editor mount point not found: '${selectorOrElement}'`);

        this._content = config.content || '';
        this._onChange = config.onChange || (() => {
        });
        this._onSelectionUpdateCallback = config.onSelectionUpdate || null;
    }

    _onChange = () => {
    };

    setContent(content) {
        throw new Error("Method 'setContent()' must be implemented.");
    }

    getContent() {
        throw new Error("Method 'getContent()' must be implemented.");
    }

    getSelection() {
        throw new Error("Method 'getSelection()' must be implemented.");
    }

    applyDecoration(range, attributes) {
        throw new Error("Method 'applyDecoration()' must be implemented.");
    }

    focus() {
        throw new Error("Method 'focus()' must be implemented.");
    }

    blur() {
        throw new Error("Method 'blur()' must be implemented.");
    }

    hasFocus() {
        throw new Error("Method 'hasFocus()' must be implemented.");
    }

    destroy() {
        throw new Error("Method 'destroy()' must be implemented.");
    }

    isActive(name, attributes) {
        throw new Error("Method 'isActive()' must be implemented.");
    }

    can(name) {
        throw new Error("Method 'can()' must be implemented.");
    }
}

// --- Tiptap Concrete Implementation ---
class TiptapEditor extends AbstractEditorLibrary {
    /** @type {import('@tiptap/core').Editor | null} */
    _tiptapInstance = null;
    _lastSetContentWasIdentical = false; // Optimization flag
    _dispatch = null; // To pass to NodeView
    _ontologyService = null; // To pass to NodeView

    constructor(selectorOrElement, config) {
        super(selectorOrElement, config);
        // Store dispatch and ontologyService passed in config
        this._dispatch = config.dispatch;
        this._ontologyService = config.ontologyService;
        if (!this._dispatch || !this._ontologyService) {
            console.error("TiptapEditor: Missing required config properties: dispatch, ontologyService");
            // Handle error appropriately, maybe throw or prevent initialization
        }
        this._initTiptap(config.editorOptions);
    }

    _initTiptap(editorOptions = {}) {
        try {
            this._tiptapInstance?.destroy(); // Ensure cleanup if re-initializing

            // --- Pass dispatch and ontologyService to NodeViews via editorProps ---
            const editorProps = {
                // Pass custom props needed by NodeViews
                dispatch: this._dispatch,
                ontologyService: this._ontologyService,
                // Include any existing editorProps if needed
                ...(editorOptions.editorProps || {})
            };

            this._tiptapInstance = new Editor({
                element: this._element,
                extensions: [
                    StarterKit.configure({
                        history: editorOptions.history ?? true,
                        // Add other StarterKit options here if needed
                    }),
                    InlineProperty, // Add our custom node extension
                    // Add more extensions like Placeholder, Link, etc.
                    ...(editorOptions.extensions || [])
                ],
                content: this._content,
                editable: editorOptions.editable ?? true,
                autofocus: editorOptions.autofocus ?? false,
                editorProps: editorProps, // Pass the props here

                onUpdate: ({ editor }) => {
                    if (this._isUpdatingInternally) return; // Prevent loops during programmatic updates

                    const newContent = this.getContent(); // Use own method

                    // Avoid triggering persistence if content is unchanged after a no-op setContent
                    if (this._lastSetContentWasIdentical && this._content === newContent) {
                        // Content hasn't genuinely changed since the last identical setContent call.
                    } else if (this._content !== newContent) {
                        // Content genuinely changed (user typing, formatting, etc.)
                        this._content = newContent; // Update internal cache FIRST
                        this._onChange();       // Fire the debounced persistence callback
                        this._lastSetContentWasIdentical = false; // Reset optimization flag
                    }

                    // Always trigger selection update for toolbar state
                    if (this._onSelectionUpdateCallback) {
                        this._onSelectionUpdateCallback(editor);
                    }
                },

                onSelectionUpdate: ({editor}) => {
                    if (this._onSelectionUpdateCallback) {
                        this._onSelectionUpdateCallback(editor);
                    }
                },
            });

            // Initialize internal content cache after creation
            this._content = this.getContent();

        } catch (error) {
            console.error("TiptapEditor: Failed to initialize Tiptap instance:", error);
            if (this._element) { // Check if element still exists
                this._element.innerHTML = `<div style="color: red; padding: 10px;">Error initializing Tiptap editor. Check console.</div>`;
            }
            this._tiptapInstance = null;
        }
    }

    setContent(content) {
        if (this.inactive()) return;

        const contentToSet = content || '';
        let currentContent;
        try {
            // Get current content directly from editor for accurate comparison
            currentContent = this._tiptapInstance.getHTML();
        } catch (error) {
            console.error("TiptapEditor.getContent (for setContent comparison) Error:", error);
            currentContent = this._content; // Fallback to cache
        }

        if (currentContent !== contentToSet) {
            this._isUpdatingInternally = true; // Set flag BEFORE command
            this._lastSetContentWasIdentical = false;
            try {
                // Use 'false' to prevent this programmatic change triggering 'onUpdate'
                this._tiptapInstance.commands.setContent(contentToSet, false);
                // Update internal cache AFTER successful command
                this._content = contentToSet;
            } catch (error) {
                console.error("TiptapEditor.setContent Error:", error);
            } finally {
                // Reset flag SYNCHRONOUSLY after command attempt
                this._isUpdatingInternally = false;
            }
        } else {
            // Content is identical, set optimization flag
            this._lastSetContentWasIdentical = true;
        }
    }

    getContent() {
        if (this.inactive()) return this._content || '';
        try {
            return this._tiptapInstance.getHTML();
        } catch (error) {
            console.error("TiptapEditor.getContent Error:", error);
            return this._content || ''; // Fallback to cache
        }
    }

    getSelection() {
        if (this.inactive()) return null;
        try {
            const {from, to, empty} = this._tiptapInstance.state.selection;
            return {from, to, empty};
        } catch (error) {
            console.error("TiptapEditor.getSelection Error:", error);
            return null;
        }
    }

    applyDecoration(range = null, attributes = {}) {
        if (this.inactive() || !attributes.style) return;

        try {
            let commandChain = this._tiptapInstance.chain().focus(); // Always focus first
            if (range && typeof range.from === 'number' && typeof range.to === 'number')
                commandChain = commandChain.setTextSelection(range);

            // Map style attribute to Tiptap commands
            const styleActions = {
                'bold': () => commandChain.toggleBold().run(),
                'italic': () => commandChain.toggleItalic().run(),
                'strike': () => commandChain.toggleStrike().run(),
                'code': () => commandChain.toggleCode().run(),
                'heading': () => {
                    const level = attributes.level && [1, 2, 3, 4, 5, 6].includes(attributes.level) ? attributes.level : 1;
                    commandChain.toggleHeading({level}).run();
                },
                'paragraph': () => commandChain.setParagraph().run(),
                'bulletList': () => commandChain.toggleBulletList().run(),
                'orderedList': () => commandChain.toggleOrderedList().run(),
                'blockquote': () => commandChain.toggleBlockquote().run(),
                'codeBlock': () => commandChain.toggleCodeBlock().run(),
                'horizontalRule': () => commandChain.setHorizontalRule().run(),
                'undo': () => commandChain.undo().run(),
                'redo': () => commandChain.redo().run(),
            };

            if (styleActions[attributes.style]) {
                styleActions[attributes.style]();
            } else {
                console.warn(`TiptapEditor.applyDecoration: Unsupported style '${attributes.style}'`);
            }
        } catch (error) {
            console.error("TiptapEditor.applyDecoration Error:", error);
        }
    }

    focus(position = 'end') {
        if (this.inactive()) return;
        try {
            this._tiptapInstance.commands.focus(position, {scrollIntoView: true});
        } catch (error) {
            console.error("TiptapEditor.focus Error:", error);
        }
    }

    blur() {
        if (this.inactive()) return;
        try {
            this._tiptapInstance.commands.blur();
        } catch (error) {
            console.error("TiptapEditor.blur Error:", error);
        }
    }

    hasFocus() {
        if (this.inactive()) return false;
        try {
            return this._tiptapInstance.isFocused;
        } catch (error) {
            console.error("TiptapEditor.hasFocus Error:", error);
            return false;
        }
    }

    destroy() {
        if (this._tiptapInstance && !this._tiptapInstance.isDestroyed) {
            try {
                this._tiptapInstance.destroy();
            } catch (error) {
                console.error("TiptapEditor.destroy Error:", error);
            }
        }
        this._tiptapInstance = null;
        // Optionally clear the mount point, but the plugin might handle this
        // if (this._element) { this._element.innerHTML = ''; }
        this._element = null;
        this._onChange = null;
        this._onSelectionUpdateCallback = null;
    }

    isActive(name, attributes = {}) {
        if (this.inactive()) return false;
        try {
            return this._tiptapInstance.isActive(name, attributes);
        } catch (error) {
            console.error(`TiptapEditor.isActive Error for ${name}:`, error);
            return false;
        }
    }

    can(name) {
        if (this.inactive()) return false;
        try {
            if (name === 'undo') return this._tiptapInstance.can().undo();
            if (name === 'redo') return this._tiptapInstance.can().redo();
            // Add specific checks for other commands if needed for disabling buttons accurately
            // Example: return this._tiptapInstance.can().can().toggleBold?.();
            return true; // Default to true if specific 'can' check isn't implemented
        } catch (error) {
            this._logError(`can for ${name}`, error);
            return false;
        }
    }

    _logError(methodName, error) {
        console.error(`TiptapEditor.${methodName} Error:`, error);
    }

    inactive() {
        return !this._tiptapInstance || this._tiptapInstance.isDestroyed;
    }
}

// --- Toolbar Rendering Function ---
function renderToolbarContent(editorInstance) {
    if (!editorInstance?._tiptapInstance || editorInstance._tiptapInstance.isDestroyed) {
        return ''; // Render nothing if editor isn't ready
    }

    const tiptap = editorInstance; // Alias for clarity

    // Helper to generate button classes based on active state
    const btnClass = (name, attrs = {}) => `toolbar-button ${tiptap.isActive(name, attrs) ? 'is-active' : ''}`;
    // Helper to generate button disabled state based on 'can' checks
    const btnDisabled = (name) => !tiptap.can(name);

    // Template for the toolbar's inner content
    return html`
        <button title="Undo (Ctrl+Z)" class="toolbar-button"
                @click=${() => tiptap.applyDecoration(null, {style: 'undo'})} .disabled=${btnDisabled('undo')}>↺
        </button>
        <button title="Redo (Ctrl+Y)" class="toolbar-button"
                @click=${() => tiptap.applyDecoration(null, {style: 'redo'})} .disabled=${btnDisabled('redo')}>↻
        </button>
        <span class="toolbar-divider"></span>
        <button title="Bold (Ctrl+B)" class=${btnClass('bold')}
                @click=${() => tiptap.applyDecoration(null, {style: 'bold'})}><b>B</b></button>
        <button title="Italic (Ctrl+I)" class=${btnClass('italic')}
                @click=${() => tiptap.applyDecoration(null, {style: 'italic'})}><i>I</i></button>
        <button title="Strikethrough" class=${btnClass('strike')}
                @click=${() => tiptap.applyDecoration(null, {style: 'strike'})}><s>S</s></button>
        <button title="Code" class=${btnClass('code')}
                @click=${() => tiptap.applyDecoration(null, {style: 'code'})}></></button>
        <span class="toolbar-divider"></span>
        <select title="Text Style" class="toolbar-select" @change=${(e) => {
            const style = e.target.value;
            if (style.startsWith('heading')) {
                const level = parseInt(style.split('-')[1], 10);
                tiptap.applyDecoration(null, {style: 'heading', level});
            } else if (style === 'paragraph') {
                tiptap.applyDecoration(null, {style: 'paragraph'});
            }
            // Optional: Reset selection visually, though Tiptap's isActive should handle the <option> selected state
            // e.target.value = '';
        }}>
            <option value="paragraph" ?selected=${tiptap.isActive('paragraph')}>Paragraph</option>
            <option value="heading-1" ?selected=${tiptap.isActive('heading', {level: 1})}>Heading 1</option>
            <option value="heading-2" ?selected=${tiptap.isActive('heading', {level: 2})}>Heading 2</option>
            <option value="heading-3" ?selected=${tiptap.isActive('heading', {level: 3})}>Heading 3</option>
            <!-- Add more heading levels or block types as needed -->
        </select>
        <span class="toolbar-divider"></span>
        <button title="Bullet List" class=${btnClass('bulletList')}
                @click=${() => tiptap.applyDecoration(null, {style: 'bulletList'})}>• List
        </button>
        <button title="Ordered List" class=${btnClass('orderedList')}
                @click=${() => tiptap.applyDecoration(null, {style: 'orderedList'})}>1. List
        </button>
        <button title="Blockquote" class=${btnClass('blockquote')}
                @click=${() => tiptap.applyDecoration(null, {style: 'blockquote'})}>" Quote
        </button>
        <button title="Code Block" class=${btnClass('codeBlock')}
                @click=${() => tiptap.applyDecoration(null, {style: 'codeBlock'})}>{} Block
        </button>
        <button title="Horizontal Rule" class="toolbar-button"
                @click=${() => tiptap.applyDecoration(null, {style: 'horizontalRule'})}>- Rule
        </button>
        <span class="toolbar-divider"></span>
        <!-- Added for Enhancement #3 -->
        <button title="Insert Template" class="toolbar-button"
                @click=${() => RichTextEditorPlugin._handleInsertTemplate()}>
            📄 Insert
        </button>
    `;
}

// --- Rich Text Editor Plugin Definition ---
export const RichTextEditorPlugin = {
    id: 'editor', // TODO Use a more specific ID if multiple editors exist?
    name: 'Rich Text Editor (Tiptap)',
    dependencies: [], // Add core API or other plugin dependencies if needed
    _editorInstance: null, // Holds the TiptapEditor instance
    _coreAPI: null,
    _currentNoteId: null,
    _toolbarUpdateQueued: false, // Prevent redundant toolbar updates

    init(coreAPI) {
        this.coreAPI = coreAPI;
        // Load specific settings for this plugin if needed
        // const settings = this.coreAPI.getPluginSettings(this.id) || {};
        console.log(`${this.name}: Initialized.`);
    },

    onActivate() {
        // Actual editor creation happens dynamically within the UI slot renderer
        console.log(`${this.name}: Activated.`);
    },

    onDeactivate() {
        this._destroyEditor(); // Clean up the editor instance
        this._currentNoteId = null;
        console.log(`${this.name}: Deactivated and cleaned up.`);
    },

    // Centralized method for destroying the editor instance
    _destroyEditor() {
        try {
            this._editorInstance?.destroy();
        } catch (error) {
            console.error(`${this.name}: Error destroying editor instance:`, error);
        }
        this._editorInstance = null;

        // Also ensure toolbar is cleared when editor is destroyed
        this._updateToolbarUI();
    },

    // Renders the toolbar content into its container
    _updateToolbarUI() {
        if (this._toolbarUpdateQueued) return; // Already scheduled

        this._toolbarUpdateQueued = true;
        requestAnimationFrame(() => {
            const toolbarContainer = document.getElementById('editor-toolbar-container');
            if (toolbarContainer) {
                // Use lit-html to render the dynamic part of the toolbar
                litRender(renderToolbarContent(this._editorInstance), toolbarContainer);
            }
            this._toolbarUpdateQueued = false; // Reset flag after update
        });
    },

    registerUISlots() {
        // --- Helper Function to get input value based on type ---
        // Moved outside startInlinePropertyEdit for clarity
        const getInputPropertyValue = (inputElement, propertyType) => {
            switch (propertyType) {
                case 'boolean':
                    return inputElement.checked;
                case 'number':
                    // Use valueAsNumber for better handling of empty strings vs 0
                    // Fallback to parseFloat if valueAsNumber isn't supported/reliable
                    return !isNaN(inputElement.valueAsNumber) ? inputElement.valueAsNumber : (inputElement.value ? parseFloat(inputElement.value) : null);
                case 'date':
                case 'time':
                case 'datetime-local':
                case 'url':
                case 'text':
                case 'textarea': // Added textarea
                default:
                    return inputElement.value;
            }
        };

        // --- Helper Function to render the property spans ---
        // IMPORTANT: This function demonstrates the logic but rendering interactive elements
        // directly into Tiptap's content area requires using Tiptap NodeViews for robustness.
        // This simple version might conflict with Tiptap's rendering.
        const renderNoteContentWithProperties = (content, noteId, propertiesData = [], dispatch) => {
            if (!content || !html) return html``; // Check if lit-html is available

            // Find properties mentioned in the content like [[key]] or [[key:value]]
            const propertyRegex = /\[\[([a-zA-Z0-9_ -]+?)(?::([^\]]+))?\]\]/g; // Matches [[key]] or [[key:value]]
            const parts = [];
            let lastIndex = 0;
            let match;

            while ((match = propertyRegex.exec(content)) !== null) {
                const key = match[1].trim();
                // Find the corresponding property data to get its type and actual value
                const propData = propertiesData.find(p => p.key.toLowerCase() === key.toLowerCase());
                const value = propData?.value ?? match[2] ?? ''; // Use stored value if available, else fallback
                const type = propData?.type ?? 'text'; // Use stored type, default to text

                const textBefore = content.substring(lastIndex, match.index);
                if (textBefore) {
                    parts.push(html`${textBefore}`);
                }

                // Pass type to the click handler
                parts.push(html`
                    <span class="inline-property"
                          data-property-key="${key}"
                          title="${key} (${type}) - Click to edit"
                          @click="${(event) => startInlinePropertyEdit(event, key, value, type, noteId, dispatch, propertiesData)}"
                          style="background-color: lightgoldenrodyellow; border: 1px dotted lightgray; padding: 0 2px; cursor: pointer; border-radius: 2px;">
                        ${value}
                    </span>`);
                lastIndex = propertyRegex.lastIndex;
            }

            const textAfter = content.substring(lastIndex);
            if (textAfter) {
                parts.push(html`${textAfter}`);
            }

            // If no matches, return the original content wrapped
            if (parts.length === 0) {
                return html`${content}`;
            }

            return html`${parts}`;
        };

        // --- Helper Function to handle the inline editing start ---
        const startInlinePropertyEdit = (event, propertyName, propertyValue, propertyType, noteId, dispatch, propertiesData) => {
            event.stopPropagation(); // Prevent triggering other editor events if possible
            const propertySpan = event.target;
            let inputElement;

            // Find the full property object to get its ID for the update action
            const currentProp = propertiesData.find(p => p.key.toLowerCase() === propertyName.toLowerCase());
            if (!currentProp) {
                console.warn(`Inline Edit: Could not find property data for key "${propertyName}"`);
                // Optionally create the property first? For now, just prevent editing.
                // Maybe dispatch PROPERTY_ADD here? Needs careful thought.
                return;
            }
            const propertyId = currentProp.id;

            // Create input based on type
            switch (propertyType) {
                case 'number':
                    inputElement = document.createElement('input');
                    inputElement.type = 'number';
                    inputElement.value = propertyValue;
                    inputElement.step = 'any'; // Allow decimals by default
                    break;
                case 'date':
                    inputElement = document.createElement('input');
                    inputElement.type = 'date';
                    // Ensure value is in YYYY-MM-DD format for the input
                    try {
                        inputElement.value = propertyValue ? new Date(propertyValue).toISOString().split('T')[0] : '';
                    } catch { inputElement.value = ''; }
                    break;
                case 'time':
                    inputElement = document.createElement('input');
                    inputElement.type = 'time';
                    inputElement.value = propertyValue; // Assumes HH:MM format
                    break;
                case 'datetime-local':
                    inputElement = document.createElement('input');
                    inputElement.type = 'datetime-local';
                    // Needs YYYY-MM-DDTHH:MM format
                    try {
                        inputElement.value = propertyValue ? new Date(propertyValue).toISOString().slice(0, 16) : '';
                    } catch { inputElement.value = ''; }
                    break;
                case 'boolean':
                    inputElement = document.createElement('input');
                    inputElement.type = 'checkbox';
                    inputElement.checked = Boolean(propertyValue);
                    // Style checkbox appropriately for inline use
                    inputElement.style.display = 'inline-block';
                    inputElement.style.verticalAlign = 'middle';
                    inputElement.style.marginLeft = '4px';
                    inputElement.style.marginRight = '4px';
                    break;
                case 'url':
                    inputElement = document.createElement('input');
                    inputElement.type = 'url';
                    inputElement.value = propertyValue;
                    break;
                case 'textarea': // Added textarea support
                    inputElement = document.createElement('textarea');
                    inputElement.value = propertyValue;
                    inputElement.rows = 3; // Example size
                    inputElement.style.width = '150px'; // Example size
                    break;
                case 'text':
                default:
                    inputElement = document.createElement('input');
                    inputElement.type = 'text';
                    inputElement.value = propertyValue;
                    break;
            }

            // Common attributes and styling
            inputElement.dataset.propertyKey = propertyName;
            inputElement.dataset.noteId = noteId;
            inputElement.dataset.propertyType = propertyType; // Store type
            inputElement.classList.add('inline-property-input'); // Add class for styling
            inputElement.style.fontSize = 'inherit'; // Match surrounding text size

            // --- Event Listeners for the Input ---
            const saveChanges = (target) => {
                const newValue = getInputPropertyValue(target, propertyType); // Use helper
                const propKey = target.dataset.propertyKey;
                const currentNoteId = target.dataset.noteId;
                const currentPropType = target.dataset.propertyType;

                // Only dispatch if value changed or if it's a boolean (checkbox state might change without value changing if initial value was non-standard)
                if (newValue !== propertyValue || propertyType === 'boolean') {
                    console.log(`Inline Edit Save: Key=${propKey}, NewValue=${newValue}, Type=${currentPropType}`);
                    dispatch({
                        type: 'PROPERTY_UPDATE',
                        payload: {
                            noteId: currentNoteId,
                            propertyId: propertyId, // Use the ID found earlier
                            changes: {
                                value: newValue,
                                type: currentPropType // Send type back to ensure it's preserved
                            }
                        }
                    });
                    // Note: The state change will trigger a re-render via the subscription,
                    // which should replace the input with the updated span (if rendering logic allows).
                } else {
                    // No change, just revert UI
                    replaceInputWithSpan();
                }
            };

            const replaceInputWithSpan = () => {
                // Check if the input is still in the DOM before trying to replace
                if (inputElement.parentNode) {
                    inputElement.replaceWith(propertySpan);
                }
            };

            inputElement.addEventListener('blur', (blurEvent) => {
                // Use setTimeout to allow click events on potential buttons (like a save button if added later)
                // to fire before the input is removed.
                setTimeout(() => {
                    // Check if focus moved to another element related to this edit (e.g., a custom save button)
                    // For now, assume blur means save or cancel (handled by keydown)
                    if (document.activeElement !== inputElement) {
                        saveChanges(blurEvent.target);
                    }
                }, 100); // Small delay
            });

            // Save on change for specific types
            inputElement.addEventListener('change', (changeEvent) => {
                const type = changeEvent.target.dataset.propertyType;
                if (['boolean', 'date', 'time', 'datetime-local', 'select'].includes(type)) { // Add 'select' if implemented
                    inputElement.blur(); // Trigger blur to save
                }
            });

            inputElement.addEventListener('keydown', (keydownEvent) => {
                if (keydownEvent.key === 'Enter') {
                    keydownEvent.preventDefault(); // Prevent form submission if inside one
                    inputElement.blur(); // Trigger save via blur
                } else if (keydownEvent.key === 'Escape') {
                    keydownEvent.preventDefault();
                    // Just replace the input with the original span, discarding changes
                    replaceInputWithSpan();
                }
            });

            // Replace span with input and focus
            propertySpan.replaceWith(inputElement);
            inputElement.focus();
            // Select text for text-based inputs
            if (['text', 'number', 'url', 'textarea'].includes(propertyType)) {
                inputElement.select();
            }
        };


        // --- Main Slot Renderer ---
        return {
            [SLOT_EDITOR_CONTENT_AREA]: (props) => {
                const { state, dispatch, noteId } = props;
                const note = noteId ? state.notes[noteId] : null;
                // Get properties data needed for rendering inline spans (though rendering happens elsewhere)
                const propertiesData = note?.pluginData?.properties?.properties || [];

                const debounceTime = 500;

                // --- Editor Mount/Update Logic (deferred to next frame) ---
                requestAnimationFrame(() => {
                    const mountPoint = document.getElementById('editor-mount-point');
                    if (!mountPoint) {
                        console.warn(`${this.name}: Mount point #editor-mount-point not found.`);
                        return; // Can't proceed without mount point
                    }

                    // --- Initialization ---
                    if (!this._editorInstance && note) {
                        try {
                            // Ensure any previous instance state is cleared (though destroy should handle)
                            this._destroyEditor();

                            this._editorInstance = new TiptapEditor(mountPoint, {
                                content: note.content || '',
                                onSelectionUpdate: () => this._updateToolbarUI(), // Use bound method
                                onChange: debounce(() => {
                                    if (!this._editorInstance || !this._currentNoteId || this._editorInstance._isUpdatingInternally) return;

                                    const currentEditorContent = this._editorInstance.getContent();
                                    const noteInState = this.coreAPI.getState().notes[this._currentNoteId];

                                    // Only dispatch if the note exists and content has changed
                                    if (noteInState && currentEditorContent !== noteInState.content) {
                                        dispatch({
                                            type: 'CORE_UPDATE_NOTE',
                                            payload: {
                                                noteId: this._currentNoteId,
                                                changes: { content: currentEditorContent }
                                            }
                                        });
                                    }
                                }, debounceTime),
                                editorOptions: {},
                            });
                            this._currentNoteId = noteId;
                            this._updateToolbarUI(); // Render toolbar after successful init
                            // Optional: Focus after loading/creating
                            // this._editorInstance.focus();
                        } catch (error) {
                            console.error(`${this.name}: Failed to initialize Tiptap editor:`, error);
                            mountPoint.innerHTML = `<div style="color: red;">Error initializing editor.</div>`;
                            this._destroyEditor();
                        }
                    } else if (this._editorInstance) {
                        const noteChanged = note && this._currentNoteId !== noteId;
                        const editorHasFocus = this._editorInstance.hasFocus();

                        // Scenario 1: Switching Notes
                        if (noteChanged) {
                            this._editorInstance.setContent(note.content || '');
                            this._currentNoteId = noteId;
                            this._updateToolbarUI();
                            // Optional: Focus when switching note
                            // if (!editorHasFocus) this._editorInstance.focus();
                        }
                        // Scenario 2: Same Note Selected
                        else if (note) {
                            const externalContentChanged = note.content !== this._editorInstance.getContent();

                            // Apply external changes ONLY if editor isn't focused to prevent overwriting typing
                            if (externalContentChanged && !editorHasFocus) {
                                this._editorInstance.setContent(note.content || '');
                                // Toolbar likely doesn't need update here unless content affects active states
                                // this._updateToolbarUI();
                            } else if (externalContentChanged && editorHasFocus) {
                                // Log potentially skipped update due to focus (for debugging)
                                // console.log(`${this.name}: Skipped external content update for note ${noteId} because editor has focus.`);
                            }
                        } else if (!note && this._currentNoteId) {
                            this._destroyEditor();
                            this._currentNoteId = null;
                            mountPoint.innerHTML = '';
                        }
                    } else if (!note && !this._editorInstance) {
                        if (!mountPoint.hasChildNodes() && !mountPoint.textContent?.trim()) {
                            mountPoint.innerHTML = `<div style="color: var(--secondary-text-color); padding: 10px;">Select or create a note.</div>`;
                        }
                        this._updateToolbarUI();
                    }
                }); // End of requestAnimationFrame

                // --- Render Structure (Toolbar container + Mount Point) ---
                // The toolbar *content* is rendered dynamically by _updateToolbarUI
                // Inline property rendering logic is defined above but NOT called here,
                // as Tiptap controls the content area. True inline editing needs NodeViews.
                return html`
                    <div class="editor-container" style="display: flex; flex-direction: column; height: 100%;">
                        <div id="editor-toolbar-container" class="editor-toolbar" role="toolbar" aria-label="Text Formatting">
                            <!-- Toolbar content rendered here by _updateToolbarUI -->
                        </div>
                        <div id="editor-mount-point"
                             style="flex-grow: 1; overflow-y: auto; border: 1px solid var(--border-color, #ccc); border-top: none; border-radius: 0 0 4px 4px; padding: 10px;"
                             class="tiptap-editor-content">
                            <!-- Tiptap editor attaches here. Inline properties won't render correctly without NodeViews -->
                            ${!note ? html`<div style="color: var(--secondary-text-color); padding: 10px;">Select or create a note.</div>` : ''}
                        </div>
                    </div>
                    <style>
                        /* Styles for inline properties and inputs */
                        .inline-property {
                            background-color: lightgoldenrodyellow;
                            border: 1px dotted lightgray;
                            padding: 0 2px;
                            cursor: pointer;
                            border-radius: 2px;
                            white-space: nowrap; /* Prevent wrapping */
                        }
                        .inline-property:hover {
                            background-color: gold;
                            border-style: dashed;
                        }
                        .inline-property-input { /* Style the inputs */
                            border: 1px solid var(--accent-color, blue);
                            padding: 1px 2px;
                            border-radius: 2px;
                            font-size: inherit; /* Match surrounding text */
                            font-family: inherit;
                            vertical-align: baseline; /* Align with text */
                            margin: 0 1px; /* Small spacing */
                        }
                        .inline-property-input[type="checkbox"] {
                             height: 0.9em; /* Adjust size */
                             width: 0.9em;
                             vertical-align: middle; /* Center checkbox */
                        }
                        .inline-property-input[type="date"],
                        .inline-property-input[type="time"],
                        .inline-property-input[type="datetime-local"] {
                            padding: 0 2px; /* Adjust padding for date/time */
                        }
                        .inline-property-input[type="textarea"] {
                            vertical-align: top; /* Align textarea better */
                            resize: vertical; /* Allow vertical resize */
                        }

                        /* ... other existing styles for toolbar, tiptap content etc. ... */
                        .editor-toolbar {
                            display: flex;
                            flex-wrap: wrap;
                            align-items: center;
                            padding: 4px 8px;
                            border: 1px solid var(--border-color, #ccc);
                            border-radius: 4px 4px 0 0;
                            background-color: var(--toolbar-bg, #f0f0f0);
                            min-height: 34px; /* Ensure consistent height */
                        }

                        .toolbar-button, .toolbar-select {
                            background: transparent;
                            border: 1px solid transparent;
                            border-radius: 3px;
                            padding: 4px 6px;
                            margin: 2px;
                            cursor: pointer;
                            font-size: 1em;
                            line-height: 1;
                            min-width: 28px;
                            text-align: center;
                            color: var(--text-color, #333);
                        }

                        .toolbar-button:hover:not(:disabled) {
                            background-color: var(--button-hover-bg, #e0e0e0);
                            border-color: var(--border-color, #ccc);
                        }

                        .toolbar-button.is-active {
                            background-color: var(--accent-color-muted, #cce5ff);
                            border-color: var(--accent-color, #99caff);
                            color: var(--accent-text-color, #004085);
                        }

                        .toolbar-button:disabled {
                            opacity: 0.5;
                            cursor: not-allowed;
                        }

                        .toolbar-select {
                            padding: 3px 4px;
                            margin: 2px 4px;
                            border: 1px solid var(--border-color, #ccc);
                            background-color: var(--input-bg, #fff);
                            color: var(--text-color, #333);
                        }

                        .toolbar-divider {
                            display: inline-block;
                            width: 1px;
                            height: 20px;
                            background-color: var(--border-color, #ccc);
                            margin: 0 8px;
                            vertical-align: middle;
                        }

                        /* Basic Tiptap content styling */
                        .tiptap-editor-content .tiptap { /* Target Tiptap's contenteditable */
                            outline: none;
                            min-height: 100px; /* Ensure it takes some space */
                        }

                        .tiptap-editor-content .tiptap > * + * {
                            margin-top: 0.75em;
                        }

                        .tiptap-editor-content .tiptap ul,
                        .tiptap-editor-content .tiptap ol {
                            padding: 0 1rem;
                            margin: 0.5em 0;
                        }

                        .tiptap-editor-content .tiptap h1, h2, h3, h4, h5, h6 {
                            line-height: 1.2;
                            margin: 1em 0 0.5em;
                        }

                        .tiptap-editor-content .tiptap p {
                            margin: 0;
                        }

                        /* Tiptap often handles P margins well */
                        .tiptap-editor-content .tiptap code:not(pre code) {
                            background-color: rgba(97, 97, 97, 0.1);
                            color: #616161;
                            padding: .1em .3em;
                            border-radius: .2em;
                            font-size: 0.9em;
                        }

                        .tiptap-editor-content .tiptap pre {
                            background: #0D0D0D;
                            color: #FFF;
                            font-family: 'JetBrainsMono', monospace;
                            white-space: pre-wrap;
                            padding: 0.75rem 1rem;
                            border-radius: 0.5rem;
                            margin: 1em 0;
                        }

                        .tiptap-editor-content .tiptap pre code {
                            color: inherit;
                            padding: 0;
                            background: none;
                            font-size: 0.9em;
                        }

                        .tiptap-editor-content .tiptap blockquote {
                            padding-left: 1rem;
                            border-left: 3px solid rgba(13, 13, 13, 0.1);
                            margin: 1em 0;
                        }

                        .tiptap-editor-content .tiptap hr {
                            border: none;
                            border-top: 2px solid rgba(13, 13, 13, 0.1);
                            margin: 2rem 0;
                        }

                        /* Placeholder Styling (if using Tiptap Placeholder extension) */
                        .tiptap-editor-content .tiptap p.is-editor-empty:first-child::before {
                            content: attr(data-placeholder);
                            float: left;
                            color: #adb5bd;
                            pointer-events: none;
                            height: 0;
                        }
                    </style>
                `;
            }
        };
    },

    providesServices() {
        // Expose a consistent API for interacting with the editor
        return {
            'EditorService': {
                getContent: () => this._editorInstance?.getContent() ?? '',
                setContent: (content) => this._editorInstance?.setContent(content),
                getSelection: () => this._editorInstance?.getSelection() ?? null,
                applyDecoration: (range, attributes) => this._editorInstance?.applyDecoration(range, attributes),
                focus: (position) => this._editorInstance?.focus(position),
                blur: () => this._editorInstance?.blur(),
                hasFocus: () => this._editorInstance?.hasFocus() ?? false,
                isEditorActive: () => !!this._editorInstance && !this._editorInstance._tiptapInstance?.isDestroyed,
                // Avoid exposing the raw Tiptap instance directly if possible
                // getTiptapInstance: () => this._editorInstance?._tiptapInstance,
            }
        };
    },

    // --- Added for Enhancement #3 ---
    _handleInsertTemplate() {
        if (!this.coreAPI || !this._editorInstance) return;

        const ontologyService = this.coreAPI.getService('OntologyService');
        if (!ontologyService) {
            this.coreAPI.showGlobalStatus("Ontology Service not available for templates.", "warning");
            return;
        }

        const templates = ontologyService.getTemplates();
        if (!templates || templates.length === 0) {
            this.coreAPI.showGlobalStatus("No templates found in ontology.", "info");
            return;
        }

        // TODO: Replace prompt with a proper modal/dropdown selection UI
        const templateNames = templates.map((t, i) => `${i + 1}: ${t.name}`).join('\n');
        const choice = prompt(`Select template to insert:\n${templateNames}`);
        const index = parseInt(choice, 10) - 1;

        if (!isNaN(index) && templates[index]) {
            const template = templates[index];
            let contentToInsert = template.content || '';
            // Basic placeholder replacement (extend as needed)
            contentToInsert = contentToInsert.replace(/{{date}}/gi, this.coreAPI.utils.formatDate(Date.now()));
            // TODO: Add more placeholder logic

            // Use EditorService to insert (assumes method exists)
            this.providesServices().EditorService.insertContentAtCursor?.(contentToInsert);
        }
    },
    // --- End Enhancement #3 ---

    // Convenience helpers bound to the plugin instance
    getContent() {
        return this.providesServices().EditorService.getContent();
    },
    setContent(content) {
        this.providesServices().EditorService.setContent(content);
    },
    // Assume EditorService has this method (added conceptually)
    insertContentAtCursor(htmlContent) {
        if (this._editorInstance && !this._editorInstance.inactive()) {
            console.log("EditorPlugin: Inserting content at cursor:", htmlContent.substring(0, 50) + "...");
            this._editorInstance._tiptapInstance?.commands.insertContent(htmlContent);
        }
    }
};
