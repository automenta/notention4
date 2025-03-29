/**
 * Rich Text Editor Plugin using Tiptap
 * Replaces a target element with a Tiptap rich text editor.
 */
"use strict";

import { Editor } from 'https://esm.sh/@tiptap/core';
import StarterKit from 'https://esm.sh/@tiptap/starter-kit';
import { html, render as litRender } from 'https://esm.sh/lit-html';

// Assuming SLOT_EDITOR_CONTENT_AREA is defined elsewhere (e.g., in ui.js)
// Example: export const SLOT_EDITOR_CONTENT_AREA = 'editorContentArea';
import { SLOT_EDITOR_CONTENT_AREA } from './ui.js';

// --- Abstract Base Class (Optional but good practice) ---
class AbstractEditorLibrary {
    _element = null;
    _content = '';
    _onChange = () => {};
    _onSelectionUpdateCallback = null;
    _isUpdatingInternally = false;

    constructor(selectorOrElement, config = {}) {
        if (new.target === AbstractEditorLibrary) {
            throw new TypeError("Cannot construct AbstractEditorLibrary instances directly");
        }
        this._element = typeof selectorOrElement === 'string'
            ? document.querySelector(selectorOrElement)
            : selectorOrElement;

        if (!this._element) {
            throw new Error(`Editor mount point not found: '${selectorOrElement}'`);
        }
        this._content = config.content || '';
        this._onChange = config.onChange || (() => {});
        this._onSelectionUpdateCallback = config.onSelectionUpdate || null;
    }

    setContent(content) { throw new Error("Method 'setContent()' must be implemented."); }
    getContent() { throw new Error("Method 'getContent()' must be implemented."); }
    getSelection() { throw new Error("Method 'getSelection()' must be implemented."); }
    applyDecoration(range, attributes) { throw new Error("Method 'applyDecoration()' must be implemented."); }
    focus() { throw new Error("Method 'focus()' must be implemented."); }
    blur() { throw new Error("Method 'blur()' must be implemented."); }
    hasFocus() { throw new Error("Method 'hasFocus()' must be implemented."); }
    destroy() { throw new Error("Method 'destroy()' must be implemented."); }
    isActive(name, attributes) { throw new Error("Method 'isActive()' must be implemented."); }
    can(name) { throw new Error("Method 'can()' must be implemented."); }
}

// --- Tiptap Concrete Implementation ---
class TiptapEditor extends AbstractEditorLibrary {
    /** @type {import('@tiptap/core').Editor | null} */
    _tiptapInstance = null;
    _lastSetContentWasIdentical = false; // Optimization flag

    constructor(selectorOrElement, config) {
        super(selectorOrElement, config);
        this._initTiptap(config.editorOptions);
    }

    _initTiptap(editorOptions = {}) {
        try {
            this._tiptapInstance?.destroy(); // Ensure cleanup if re-initializing

            this._tiptapInstance = new Editor({
                element: this._element,
                extensions: [
                    StarterKit.configure({
                        history: editorOptions.history ?? true,
                        // Add other StarterKit options here if needed
                    }),
                    // Add more extensions like Placeholder, Link, etc.
                    ...(editorOptions.extensions || [])
                ],
                content: this._content,
                editable: editorOptions.editable ?? true,
                autofocus: editorOptions.autofocus ?? false,

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

                onSelectionUpdate: ({ editor }) => {
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
        if (!this._tiptapInstance || this._tiptapInstance.isDestroyed) return;

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
        if (!this._tiptapInstance || this._tiptapInstance.isDestroyed) return this._content || '';
        try {
            return this._tiptapInstance.getHTML();
        } catch (error) {
            console.error("TiptapEditor.getContent Error:", error);
            return this._content || ''; // Fallback to cache
        }
    }

    getSelection() {
        if (!this._tiptapInstance || this._tiptapInstance.isDestroyed) return null;
        try {
            const { from, to, empty } = this._tiptapInstance.state.selection;
            return { from, to, empty };
        } catch (error) {
            console.error("TiptapEditor.getSelection Error:", error);
            return null;
        }
    }

    applyDecoration(range = null, attributes = {}) {
        if (!this._tiptapInstance || this._tiptapInstance.isDestroyed || !attributes.style) return;

        try {
            let commandChain = this._tiptapInstance.chain().focus(); // Always focus first
            if (range && typeof range.from === 'number' && typeof range.to === 'number') {
                commandChain = commandChain.setTextSelection(range);
            }

            // Map style attribute to Tiptap commands
            const styleActions = {
                'bold': () => commandChain.toggleBold().run(),
                'italic': () => commandChain.toggleItalic().run(),
                'strike': () => commandChain.toggleStrike().run(),
                'code': () => commandChain.toggleCode().run(),
                'heading': () => {
                    const level = attributes.level && [1, 2, 3, 4, 5, 6].includes(attributes.level) ? attributes.level : 1;
                    commandChain.toggleHeading({ level }).run();
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
        if (!this._tiptapInstance || this._tiptapInstance.isDestroyed) return;
        try { this._tiptapInstance.commands.focus(position, { scrollIntoView: true }); }
        catch (error) { console.error("TiptapEditor.focus Error:", error); }
    }

    blur() {
        if (!this._tiptapInstance || this._tiptapInstance.isDestroyed) return;
        try { this._tiptapInstance.commands.blur(); }
        catch (error) { console.error("TiptapEditor.blur Error:", error); }
    }

    hasFocus() {
        if (!this._tiptapInstance || this._tiptapInstance.isDestroyed) return false;
        try { return this._tiptapInstance.isFocused; }
        catch (error) { console.error("TiptapEditor.hasFocus Error:", error); return false; }
    }

    destroy() {
        if (this._tiptapInstance && !this._tiptapInstance.isDestroyed) {
            try { this._tiptapInstance.destroy(); }
            catch (error) { console.error("TiptapEditor.destroy Error:", error); }
        }
        this._tiptapInstance = null;
        // Optionally clear the mount point, but the plugin might handle this
        // if (this._element) { this._element.innerHTML = ''; }
        this._element = null;
        this._onChange = null;
        this._onSelectionUpdateCallback = null;
    }

    isActive(name, attributes = {}) {
        if (!this._tiptapInstance || this._tiptapInstance.isDestroyed) return false;
        try {
            return this._tiptapInstance.isActive(name, attributes);
        } catch (error) {
            console.error(`TiptapEditor.isActive Error for ${name}:`, error);
            return false;
        }
    }

    can(name) {
        if (!this._tiptapInstance || this._tiptapInstance.isDestroyed) return false;
        try {
            if (name === 'undo') return this._tiptapInstance.can().undo();
            if (name === 'redo') return this._tiptapInstance.can().redo();
            // Add specific checks for other commands if needed for disabling buttons accurately
            // Example: return this._tiptapInstance.can().toggleBold?.();
            return true; // Default to true if specific 'can' check isn't implemented
        } catch (error) {
            console.error(`TiptapEditor.can Error for ${name}:`, error);
            return false;
        }
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
        <button title="Undo (Ctrl+Z)" class="toolbar-button" @click=${() => tiptap.applyDecoration(null, { style: 'undo' })} .disabled=${btnDisabled('undo')}>↺</button>
        <button title="Redo (Ctrl+Y)" class="toolbar-button" @click=${() => tiptap.applyDecoration(null, { style: 'redo' })} .disabled=${btnDisabled('redo')}>↻</button>
        <span class="toolbar-divider"></span>
        <button title="Bold (Ctrl+B)" class=${btnClass('bold')} @click=${() => tiptap.applyDecoration(null, { style: 'bold' })}><b>B</b></button>
        <button title="Italic (Ctrl+I)" class=${btnClass('italic')} @click=${() => tiptap.applyDecoration(null, { style: 'italic' })}><i>I</i></button>
        <button title="Strikethrough" class=${btnClass('strike')} @click=${() => tiptap.applyDecoration(null, { style: 'strike' })}><s>S</s></button>
        <button title="Code" class=${btnClass('code')} @click=${() => tiptap.applyDecoration(null, { style: 'code' })}></></button>
        <span class="toolbar-divider"></span>
        <select title="Text Style" class="toolbar-select" @change=${(e) => {
        const style = e.target.value;
        if (style.startsWith('heading')) {
            const level = parseInt(style.split('-')[1], 10);
            tiptap.applyDecoration(null, { style: 'heading', level });
        } else if (style === 'paragraph') {
            tiptap.applyDecoration(null, { style: 'paragraph'});
        }
        // Optional: Reset selection visually, though Tiptap's isActive should handle the <option> selected state
        // e.target.value = '';
    }}>
            <option value="paragraph" ?selected=${tiptap.isActive('paragraph')}>Paragraph</option>
            <option value="heading-1" ?selected=${tiptap.isActive('heading', { level: 1 })}>Heading 1</option>
            <option value="heading-2" ?selected=${tiptap.isActive('heading', { level: 2 })}>Heading 2</option>
            <option value="heading-3" ?selected=${tiptap.isActive('heading', { level: 3 })}>Heading 3</option>
            <!-- Add more heading levels or block types as needed -->
        </select>
        <span class="toolbar-divider"></span>
        <button title="Bullet List" class=${btnClass('bulletList')} @click=${() => tiptap.applyDecoration(null, { style: 'bulletList' })}>• List</button>
        <button title="Ordered List" class=${btnClass('orderedList')} @click=${() => tiptap.applyDecoration(null, { style: 'orderedList' })}>1. List</button>
        <button title="Blockquote" class=${btnClass('blockquote')} @click=${() => tiptap.applyDecoration(null, { style: 'blockquote' })}>" Quote</button>
        <button title="Code Block" class=${btnClass('codeBlock')} @click=${() => tiptap.applyDecoration(null, { style: 'codeBlock' })}>{} Block</button>
        <button title="Horizontal Rule" class="toolbar-button" @click=${() => tiptap.applyDecoration(null, { style: 'horizontalRule' })}>- Rule</button>
    `;
}

// --- Rich Text Editor Plugin Definition ---
export const RichTextEditorPlugin = {
    id: 'richTextEditor', // Use a more specific ID if multiple editors exist
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
        return {
            [SLOT_EDITOR_CONTENT_AREA]: (props) => {
                const { state, dispatch, noteId } = props;
                const note = noteId ? state.notes[noteId] : null;
                const editorSettings = this.coreAPI.getPluginSettings(this.id) || {};
                const debounceTime = editorSettings.debounceTime ?? 500;

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
                                onChange: this.coreAPI.utils.debounce(() => {
                                    if (!this._editorInstance || !this._currentNoteId || this._editorInstance._isUpdatingInternally) return;

                                    const currentEditorContent = this._editorInstance.getContent();
                                    const noteInState = this.coreAPI.getState().notes[this._currentNoteId];

                                    // Only dispatch if the note exists and content has changed
                                    if (noteInState && currentEditorContent !== noteInState.content) {
                                        dispatch({
                                            type: 'CORE_UPDATE_NOTE',
                                            payload: { noteId: this._currentNoteId, changes: { content: currentEditorContent } }
                                        });
                                    }
                                }, debounceTime),
                                editorOptions: {
                                    // Pass any Tiptap specific options from settings here
                                    // history: editorSettings.enableHistory ?? true,
                                }
                            });
                            this._currentNoteId = noteId;
                            this._updateToolbarUI(); // Render toolbar after successful init
                            // Optional: Focus after loading/creating
                            // this._editorInstance.focus();

                        } catch (error) {
                            console.error(`${this.name}: Failed to initialize Tiptap editor:`, error);
                            mountPoint.innerHTML = `<div style="color: red;">Error initializing editor.</div>`;
                            this._destroyEditor(); // Ensure cleanup on error
                        }
                    }
                    // --- Update Existing Instance ---
                    else if (this._editorInstance) {
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
                        }
                        // Scenario 3: No Note Selected (or note deleted while editor active)
                        else if (!note && this._currentNoteId) {
                            this._destroyEditor(); // Destroy instance if no note is selected
                            this._currentNoteId = null;
                            mountPoint.innerHTML = ''; // Clear mount point
                            // Toolbar is cleared by _destroyEditor -> _updateToolbarUI
                        }
                    }
                    // --- No Instance, No Note ---
                    else if (!note && !this._editorInstance) {
                        // Ensure placeholder text is shown if mount point is empty
                        if (!mountPoint.hasChildNodes() && !mountPoint.textContent?.trim()) {
                            mountPoint.innerHTML = `<div style="color: var(--secondary-text-color); padding: 10px;">Select or create a note.</div>`;
                        }
                        // Ensure toolbar is empty
                        this._updateToolbarUI();
                    }
                }); // End requestAnimationFrame

                // --- Render Structure (Toolbar container + Mount Point) ---
                // The toolbar *content* is rendered dynamically by _updateToolbarUI
                return html`
                    <div class="editor-container" style="display: flex; flex-direction: column; height: 100%;">
                        <div id="editor-toolbar-container" class="editor-toolbar" role="toolbar" aria-label="Text Formatting">
                            <!-- Toolbar content rendered here by _updateToolbarUI -->
                        </div>
                        <div id="editor-mount-point" style="flex-grow: 1; overflow-y: auto; border: 1px solid var(--border-color, #ccc); border-top: none; border-radius: 0 0 4px 4px; padding: 10px;" class="tiptap-editor-content">
                            <!-- Tiptap editor attaches here -->
                            ${!note && !this._editorInstance ? html`<div style="color: var(--secondary-text-color); padding: 10px;">Select or create a note.</div>` : ''}
                        </div>
                    </div>
                    <style>
                      .editor-toolbar {
                        display: flex; flex-wrap: wrap; align-items: center;
                        padding: 4px 8px;
                        border: 1px solid var(--border-color, #ccc);
                        border-radius: 4px 4px 0 0;
                        background-color: var(--toolbar-bg, #f0f0f0);
                        min-height: 34px; /* Ensure consistent height */
                      }
                      .toolbar-button, .toolbar-select {
                        background: transparent; border: 1px solid transparent; border-radius: 3px;
                        padding: 4px 6px; margin: 2px; cursor: pointer;
                        font-size: 1em; line-height: 1; min-width: 28px; text-align: center;
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
                      .toolbar-button:disabled { opacity: 0.5; cursor: not-allowed; }
                      .toolbar-select {
                        padding: 3px 4px; margin: 2px 4px;
                        border: 1px solid var(--border-color, #ccc);
                        background-color: var(--input-bg, #fff);
                        color: var(--text-color, #333);
                      }
                      .toolbar-divider {
                        display: inline-block; width: 1px; height: 20px;
                        background-color: var(--border-color, #ccc);
                        margin: 0 8px; vertical-align: middle;
                      }
                      /* Basic Tiptap content styling */
                      .tiptap-editor-content .tiptap { /* Target Tiptap's contenteditable */
                          outline: none; min-height: 100px; /* Ensure it takes some space */
                      }
                      .tiptap-editor-content .tiptap > * + * { margin-top: 0.75em; }
                      .tiptap-editor-content .tiptap ul,
                      .tiptap-editor-content .tiptap ol { padding: 0 1rem; margin: 0.5em 0; }
                      .tiptap-editor-content .tiptap h1, h2, h3, h4, h5, h6 { line-height: 1.2; margin: 1em 0 0.5em; }
                      .tiptap-editor-content .tiptap p { margin: 0; } /* Tiptap often handles P margins well */
                      .tiptap-editor-content .tiptap code:not(pre code) {
                          background-color: rgba(97, 97, 97, 0.1); color: #616161;
                          padding: .1em .3em; border-radius: .2em; font-size: 0.9em;
                      }
                      .tiptap-editor-content .tiptap pre {
                          background: #0D0D0D; color: #FFF;
                          font-family: 'JetBrainsMono', monospace; white-space: pre-wrap;
                          padding: 0.75rem 1rem; border-radius: 0.5rem; margin: 1em 0;
                      }
                      .tiptap-editor-content .tiptap pre code {
                          color: inherit; padding: 0; background: none; font-size: 0.9em;
                      }
                      .tiptap-editor-content .tiptap blockquote {
                          padding-left: 1rem; border-left: 3px solid rgba(13, 13, 13, 0.1);
                          margin: 1em 0;
                      }
                      .tiptap-editor-content .tiptap hr {
                          border: none; border-top: 2px solid rgba(13, 13, 13, 0.1);
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

    // Convenience helpers bound to the plugin instance
    getContent() {
        return this.providesServices().EditorService.getContent();
    },
    setContent(content) {
        this.providesServices().EditorService.setContent(content);
    },
};