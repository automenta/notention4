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
        <button title="Generate Content via AI" class="toolbar-button llm-action-button"
                @click=${() => RichTextEditorPlugin._handleGenerateContent()}>
            ✨ Generate
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

        // --- REMOVED getInputPropertyValue ---
        // --- REMOVED renderNoteContentWithProperties ---
        // --- REMOVED startInlinePropertyEdit ---


        // --- Main Slot Renderer ---
        return {
            [SLOT_EDITOR_CONTENT_AREA]: (props) => {
                const { state, dispatch, noteId } = props;
                const note = noteId ? state.notes[noteId] : null;
                // Properties data is no longer directly used for rendering here
                // const propertiesData = note?.pluginData?.properties?.properties || [];

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
                            // Ensure any previous instance state is cleared
                            this._destroyEditor();

                            this._editorInstance = new TiptapEditor(mountPoint, {
                                content: note.content || '',
                                onSelectionUpdate: () => this._updateToolbarUI(),
                                onChange: debounce(() => {
                                    if (!this._editorInstance || !this._currentNoteId || this._editorInstance._isUpdatingInternally) return;
                                    const currentEditorContent = this._editorInstance.getContent();
                                    const noteInState = this.coreAPI.getState().notes[this._currentNoteId];
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
                                // Pass services needed by NodeViews
                                dispatch: dispatch,
                                ontologyService: this.coreAPI.getService('OntologyService')
                            });
                            this._currentNoteId = noteId;
                            this._updateToolbarUI();
                        } catch (error) {
                            console.error(`${this.name}: Failed to initialize Tiptap editor:`, error);
                            mountPoint.innerHTML = `<div style="color: red;">Error initializing editor.</div>`;
                            this._destroyEditor();
                        }
                    } else if (this._editorInstance) {
                        // --- Update Logic (largely unchanged, but relies on Tiptap rendering) ---
                        const noteChanged = note && this._currentNoteId !== noteId;
                        const editorHasFocus = this._editorInstance.hasFocus();

                        if (noteChanged) {
                            this._editorInstance.setContent(note.content || '');
                            this._currentNoteId = noteId;
                            this._updateToolbarUI();
                        } else if (note) {
                            const externalContentChanged = note.content !== this._editorInstance.getContent();
                            if (externalContentChanged && !editorHasFocus) {
                                this._editorInstance.setContent(note.content || '');
                            } else if (externalContentChanged && editorHasFocus) {
                                // console.log(`${this.name}: Skipped external content update for note ${noteId} because editor has focus.`);
                            }
                        } else if (!note && this._currentNoteId) {
                            this._destroyEditor();
                            this._currentNoteId = null;
                            mountPoint.innerHTML = ''; // Clear mount point
                        }
                    } else if (!note && !this._editorInstance) {
                        // Clear mount point if no note and no editor instance
                        if (!mountPoint.hasChildNodes() || mountPoint.textContent?.trim()) {
                             mountPoint.innerHTML = ''; // Clear previous content like "Select note"
                        }
                        this._updateToolbarUI(); // Ensure toolbar is cleared/updated
                    }
                }); // End of requestAnimationFrame

                // --- Render Structure (Toolbar container + Mount Point) ---
                // Tiptap now controls the content area entirely.
                return html`
                    <div class="editor-container" style="display: flex; flex-direction: column; height: 100%;">
                        <div id="editor-toolbar-container" class="editor-toolbar" role="toolbar" aria-label="Text Formatting">
                            <!-- Toolbar content rendered here by _updateToolbarUI -->
                        </div>
                        <div id="editor-mount-point"
                             style="flex-grow: 1; overflow-y: auto; border: 1px solid var(--border-color, #ccc); border-top: none; border-radius: 0 0 4px 4px; padding: 10px;"
                             class="tiptap-editor-content" data-note-id=${noteId || ''}>
                            <!-- Tiptap editor attaches here. NodeViews handle inline properties. -->
                            ${!note && !this._editorInstance ? html`<div style="color: var(--secondary-text-color); padding: 10px;">Select or create a note.</div>` : ''}
                        </div>
                    </div>
                    <style>
                        /* --- REMOVED .inline-property styles --- */
                        /* --- REMOVED .inline-property-input styles (now inside NodeView styles) --- */

                        /* --- Styles for NodeView --- */
                        .inline-property-nodeview {
                            display: inline-block; /* Behave like a span */
                            vertical-align: baseline;
                            margin: 0 1px;
                            padding: 0;
                            border-radius: 3px;
                            /* Add transition for smoother hover? */
                        }
                        .inline-property-nodeview .inline-property-display {
                            display: inline-block; /* Needed for padding/border */
                            background-color: var(--prop-inline-bg, #f0f0f0);
                            border: 1px solid var(--prop-inline-border, #ddd);
                            border-radius: 3px;
                            padding: 0px 4px;
                            cursor: pointer;
                            white-space: nowrap;
                            line-height: 1.4; /* Adjust for better vertical alignment */
                            color: var(--prop-inline-text, #333);
                        }
                        .inline-property-nodeview .inline-property-display:hover {
                            background-color: var(--prop-inline-hover-bg, #e0e0e0);
                            border-color: var(--prop-inline-hover-border, #ccc);
                        }
                        .inline-property-nodeview .property-icon {
                            margin-right: 3px;
                            font-size: 0.9em;
                            opacity: 0.8;
                        }
                        .inline-property-nodeview .property-key {
                            font-weight: 500; /* Slightly bolder key */
                            margin-right: 2px;
                            color: var(--prop-color, #555); /* Use color from hint */
                        }
                        .inline-property-nodeview .property-value {
                            /* Styles for value */
                        }
                        /* Style when selected by Tiptap */
                        .ProseMirror-selectednode > .inline-property-nodeview .inline-property-display { /* Target child */
                            box-shadow: 0 0 0 2px var(--accent-color, blue);
                            background-color: var(--prop-inline-hover-bg, #e0e0e0); /* Keep hover style when selected */
                        }
                        /* Input styling within NodeView */
                        .inline-property-nodeview .inline-property-input {
                            border: 1px solid var(--accent-color, blue);
                            padding: 0px 3px; /* Minimal padding */
                            border-radius: 2px;
                            font-size: inherit;
                            font-family: inherit;
                            vertical-align: baseline;
                            line-height: 1.3; /* Match display */
                            margin: 0; /* No extra margin */
                            /* Adjust width based on type? */
                        }
                        .inline-property-nodeview .inline-property-input[type="checkbox"] {
                            height: 0.9em; width: 0.9em; vertical-align: middle;
                        }
                        .inline-property-nodeview .inline-property-input[type="date"],
                        .inline-property-nodeview .inline-property-input[type="time"],
                        .inline-property-nodeview .inline-property-input[type="datetime-local"] {
                            padding: 0 2px;
                        }
                        .inline-property-nodeview .inline-property-input[type="range"] {
                            vertical-align: middle;
                            padding: 0;
                        }
                        .inline-property-nodeview select.inline-property-input { /* Style select specifically */
                            padding: 0 2px;
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
                getSelectedText: () => {
                    if (!this._editorInstance || this._editorInstance.inactive()) return '';
                    const { from, to, empty } = this._editorInstance.getSelection() || {};
                    if (empty || !from || !to) return '';
                    try {
                        return this._editorInstance._tiptapInstance.state.doc.textBetween(from, to, ' ');
                    } catch (e) {
                        console.error("EditorService.getSelectedText Error:", e);
                        return '';
                    }
                },
                insertContentAtCursor: (content) => { // Ensure this is exposed
                    if (this._editorInstance && !this._editorInstance.inactive()) {
                        console.log("EditorService: Inserting content at cursor:", content.substring(0, 50) + "...");
                        this._editorInstance._tiptapInstance?.commands.insertContent(content);
                    }
                },
                // Avoid exposing the raw Tiptap instance directly if possible
                // getTiptapInstance: () => this._editorInstance?._tiptapInstance,
            }
        };
    },

    // --- Middleware to handle TEMPLATE_SELECTED action ---
    registerMiddleware() {
        const pluginInstance = this;
        return storeApi => next => action => {
            if (action.type === 'TEMPLATE_SELECTED') {
                const { template, context } = action.payload;
                if (context === 'insert') {
                    pluginInstance._insertTemplateContent(template);
                } else if (context === 'generate') {
                    pluginInstance._generateContentFromTemplate(template);
                }
            }
            return next(action);
        };
    },

    // --- Refactored Content Generation Logic ---
    async _generateContentFromTemplate(selectedTemplate) {
        if (!this.coreAPI || !this._editorInstance || !this._currentNoteId || !selectedTemplate) return;

        const llmService = this.coreAPI.getService('LLMService');
        const propertiesAPI = this.coreAPI.getPluginAPI('properties');

        if (!llmService || !propertiesAPI) {
            this.coreAPI.showGlobalStatus("Cannot generate content: Required services (LLM, Properties) not available.", "warning");
            return;
        }

        const currentProperties = propertiesAPI.getPropertiesForNote(this._currentNoteId);
        this.coreAPI.showGlobalStatus(`Generating content using template "${selectedTemplate.name}"...`, "info");

        try {
            const generatedContent = await llmService.generateContent(selectedTemplate.name, currentProperties);

            if (generatedContent) {
                this.providesServices().EditorService.insertContentAtCursor?.(generatedContent);
                this.coreAPI.showGlobalStatus("AI content generated and inserted.", "success", 3000);
            } else {
                this.coreAPI.showGlobalStatus("AI content generation failed.", "warning", 4000);
            }
        } catch (error) {
            console.error("EditorPlugin: Error during content generation call:", error);
            this.coreAPI.showGlobalStatus(`Error generating content: ${error.message}`, "error", 5000);
        }
    },

    // --- Trigger for Content Generation Modal ---
    _handleGenerateContent() {
        if (!this.coreAPI || !this._editorInstance || !this._currentNoteId) return;

        const ontologyService = this.coreAPI.getService('OntologyService');
        const llmService = this.coreAPI.getService('LLMService');
        const propertiesAPI = this.coreAPI.getPluginAPI('properties'); // Or get from state

        if (!ontologyService || !llmService || !propertiesAPI) {
            this.coreAPI.showGlobalStatus("Cannot generate content: Required services (Ontology, LLM, Properties) not available.", "warning");
            return;
        }

        const templates = ontologyService.getTemplates();
        if (!templates || templates.length === 0) {
            this.coreAPI.showGlobalStatus("No templates found in ontology for generation.", "info");
            return;
        }

        // Dispatch action to open the template selector modal
        this.coreAPI.dispatch({
            type: 'CORE_OPEN_MODAL',
            payload: {
                modalType: 'templateSelector',
                modalProps: {
                    templates: templates,
                    context: 'generate', // Indicate the context
                    onSelectActionType: 'TEMPLATE_SELECTED' // Action dispatched by modal
                }
            }
        });
    },
    // --- End Refactored Content Generation ---


    // --- Refactored Template Insertion Logic ---
    _insertTemplateContent(template) {
         if (!this.coreAPI || !this._editorInstance || !template) return;

         let contentToInsert = template.content || '';
         // Basic placeholder replacement (extend as needed)
         contentToInsert = contentToInsert.replace(/{{date}}/gi, this.coreAPI.utils.formatDate(Date.now()));
         // TODO: Add more placeholder logic

         // Use EditorService to insert
         this.providesServices().EditorService.insertContentAtCursor?.(contentToInsert);
         this.coreAPI.showGlobalStatus(`Template "${template.name}" inserted.`, "success", 2000);
    },

    // --- Trigger for Template Insertion Modal ---
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

        // Dispatch action to open the template selector modal
        this.coreAPI.dispatch({
            type: 'CORE_OPEN_MODAL',
            payload: {
                modalType: 'templateSelector',
                modalProps: {
                    templates: templates,
                    context: 'insert', // Indicate the context
                    onSelectActionType: 'TEMPLATE_SELECTED' // Action dispatched by modal
                }
            }
        });
    },
    // --- End Refactored Template Insertion ---

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
