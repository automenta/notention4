// editor.js
/**
 * Crystallized Rich Text Editor Plugin using Tiptap
 *
 * Implements the requested modifications:
 * - Replaces Paragraph/Header formatting with Font Size selection.
 * - Adds Underline formatting.
 * - Aims for completeness, correctness, compactness, consolidation,
 *   deduplication, modularity, self-documentation, and modern JS usage.
 */
"use strict";

import { Editor } from '@tiptap/core';
import { Plugin as ProseMirrorPlugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextStyle from '@tiptap/extension-text-style';
import { InlineProperty } from './InlineProperty.js';
import tippy from 'tippy.js';
import 'tippy.js/dist/tippy.css';
import { Utils } from "./util.js";
import { SLOT_EDITOR_CONTENT_AREA } from './ui.js';

// Ensure lit is available
const { html, render: litRender } = window.lit ?? window.litHtml ?? (() => {
    console.error("Lit-html not found. UI rendering will fail.");
    return {
        html: (strings, ...values) => strings.map((str, i) => str + (values[i] || '')).join(''),
        render: (template, container) => { container.innerHTML = template; }
    };
})();

const debounce = Utils.debounce;

// --- Tiptap Editor Abstraction ---
class AbstractEditorLibrary {
    _element = null;
    _content = '';
    _onSelectionUpdateCallback = null;
    _isUpdatingInternally = false;
    _onChange = () => { };

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
        this._onChange = config.onChange || (() => { });
        this._onSelectionUpdateCallback = config.onSelectionUpdate || null;
    }

    setContent(content) { throw new Error("Method 'setContent()' must be implemented."); }
    getContent() { throw new Error("Method 'getContent()' must be implemented."); }
    getSelection() { throw new Error("Method 'getSelection()' must be implemented."); }
    getSelectedText() { throw new Error("Method 'getSelectedText()' must be implemented."); }
    insertContentAtCursor(content) { throw new Error("Method 'insertContentAtCursor()' must be implemented."); }
    applyStyle(styleConfig) { throw new Error("Method 'applyStyle()' must be implemented."); }
    focus(position) { throw new Error("Method 'focus()' must be implemented."); }
    blur() { throw new Error("Method 'blur()' must be implemented."); }
    hasFocus() { throw new Error("Method 'hasFocus()' must be implemented."); }
    destroy() { throw new Error("Method 'destroy()' must be implemented."); }
    isActive(name, attributes) { throw new Error("Method 'isActive()' must be implemented."); }
    can(command) { throw new Error("Method 'can()' must be implemented."); }
    getAttributes(typeOrName) { throw new Error("Method 'getAttributes()' must be implemented."); }
}

import { Extension } from '@tiptap/core'

const FontSize = Extension.create({
    name: 'fontSize',

    addOptions() {
        return {
            types: ['textStyle'],
            fontSizes: ['10pt', '12pt', '14pt', '16pt', '20pt', '24pt', '32pt'], // Default sizes
        }
    },

    addGlobalAttributes() {
        return [
            {
                types: this.options.types,
                attributes: {
                    fontSize: {
                        default: null,
                        parseHTML: element => element.style.fontSize || null,
                        renderHTML: attributes => {
                            if (!attributes.fontSize) {
                                return {}
                            }
                            // Ensure the value is one of the allowed sizes or handle appropriately
                            // if (!this.options.fontSizes.includes(attributes.fontSize)) {
                            //   console.warn(`FontSize: Rendering unexpected size: ${attributes.fontSize}`);
                            //   // return {}; // Optionally filter out unexpected sizes
                            // }
                            return {
                                style: `font-size: ${attributes.fontSize}`,
                            }
                        },
                    },
                },
            },
        ]
    },

    addCommands() {
        return {
            setFontSize: (fontSize) => ({ chain }) => {
                // Ensure fontSize is in the allowed list or handle default/empty case
                if (!fontSize || !this.options.fontSizes.includes(fontSize)) {
                    // If attempting to set an invalid size, consider unsetting or logging
                    // For now, let's just unset if the value isn't valid/provided
                    return chain().setMark('textStyle', { fontSize: null }).removeEmptyTextStyle().run();
                }
                return chain()
                    .setMark('textStyle', { fontSize })
                    .run()
            },
            unsetFontSize: () => ({ chain }) => {
                return chain()
                    .setMark('textStyle', { fontSize: null })
                    .removeEmptyTextStyle() // Important: cleans up empty style tags
                    .run()
            },
        }
    },

    // Required dependencies
    addExtensions() {
        return [TextStyle.configure({ types: this.options.types })];
    }
})

// --- Tiptap Concrete Implementation ---
class TiptapEditor extends AbstractEditorLibrary {
    /** @type {import('@tiptap/core').Editor | null} */
    _tiptapInstance = null;
    _lastSetContentWasIdentical = false;
    _dispatch = null;
    _ontologyService = null;
    _coreAPI = null;

    static FONT_SIZES = ['10pt', '12pt', '14pt', '16pt', '20pt', '24pt', '32pt'];

    constructor(selectorOrElement, config) {
        super(selectorOrElement, config);
        this._dispatch = config.dispatch;
        this._ontologyService = config.ontologyService;
        this._coreAPI = config.coreAPI;
        if (!this._dispatch || !this._ontologyService || !this._coreAPI) {
            console.error("TiptapEditor: Missing required config properties: dispatch, ontologyService, coreAPI");
        }
        this._initTiptap(config);
    }

    _initTiptap(config = {}) {
        try {
            this._tiptapInstance?.destroy();
            const editorOptions = config.editorOptions || {};
            const editorProps = {
                dispatch: this._dispatch,
                ontologyService: this._ontologyService,
                coreAPI: this._coreAPI,
                ...(editorOptions.editorProps || {})
            };
            this._tiptapInstance = new Editor({
                element: this._element,
                extensions: [
                    StarterKit.configure({ history: editorOptions.history ?? true }),
                    Underline,
                    TextStyle,
                    FontSize.configure({ fontSizes: TiptapEditor.FONT_SIZES }),
                    InlineProperty,
                    SuggestionPlugin(this._dispatch),
                    ...(editorOptions.extensions || []),
                ],
                content: this._content,
                editable: editorOptions.editable ?? true,
                autofocus: editorOptions.autofocus ?? false,
                editorProps: editorProps,
                onUpdate: ({ editor }) => {
                    if (this._isUpdatingInternally) return;
                    const newContent = this.getContent();
                    // Check if content actually changed from the last known state
                    if (this._content !== newContent) {
                        this._content = newContent; // Update internal cache immediately
                        this._onChange(); // Trigger the debounced save
                        this._lastSetContentWasIdentical = false; // Reset flag
                    }
                    if (this._onSelectionUpdateCallback) this._onSelectionUpdateCallback(editor);
                },
                onSelectionUpdate: ({ editor }) => {
                    if (this._onSelectionUpdateCallback) this._onSelectionUpdateCallback(editor);
                },
                // Add transaction listener to potentially catch external updates?
                // onTransaction: ({ transaction }) => {
                //     // Check if the transaction was not originated by the editor itself
                //     if (!transaction.getMeta('uiEvent')) {
                //         // Potentially update internal state or cache if needed
                //     }
                // }
            });
            this._content = this.getContent(); // Initialize internal cache
        } catch (error) {
            this._logError("Initialization", error);
            if (this._element) this._element.innerHTML = `<div style="color: red; padding: 10px;">Error initializing editor. Check console.</div>`;
            this._tiptapInstance = null;
        }
    }

    setContent(content) {
        if (this.inactive()) return;
        const contentToSet = content || '';
        let currentContent;
        try { currentContent = this._tiptapInstance.getHTML(); }
        catch (error) { this._logError("getContent (for setContent comparison)", error); currentContent = this._content; }

        if (currentContent !== contentToSet) {
            this._isUpdatingInternally = true;
            this._lastSetContentWasIdentical = false;
            try {
                // Set content without emitting an update event to prevent loops
                this._tiptapInstance.commands.setContent(contentToSet, false);
                this._content = contentToSet; // Update internal cache AFTER successful set
            }
            catch (error) {
                this._logError("setContent", error);
                // If setContent fails, should we revert the internal cache?
                // this._content = currentContent; // Maybe revert? Needs testing.
            }
            finally {
                // Use requestAnimationFrame to ensure the internal update flag is reset *after*
                // the current rendering cycle, preventing potential race conditions with onUpdate.
                requestAnimationFrame(() => {
                    this._isUpdatingInternally = false;
                });
            }
        } else {
            this._lastSetContentWasIdentical = true;
        }
    }

    getContent() {
        if (this.inactive()) return this._content || '';
        try { return this._tiptapInstance.getHTML(); }
        catch (error) { this._logError("getContent", error); return this._content || ''; }
    }

    getSelection() {
        if (this.inactive()) return null;
        try { const { from, to, empty } = this._tiptapInstance.state.selection; return { from, to, empty }; }
        catch (error) { this._logError("getSelection", error); return null; }
    }

    getSelectedText() {
        if (this.inactive()) return '';
        try { const { from, to, empty } = this.getSelection() || {}; if (empty || typeof from !== 'number' || typeof to !== 'number') return ''; return this._tiptapInstance.state.doc.textBetween(from, to, ' '); }
        catch (error) { this._logError("getSelectedText", error); return ''; }
    }

    insertContentAtCursor(content) {
        if (this.inactive()) return;
        try { this._tiptapInstance?.chain().focus().insertContent(content).run(); }
        catch (error) { this._logError("insertContentAtCursor", error); }
    }

    applyStyle(styleConfig) {
        if (this.inactive()) return;
        try {
            const chain = this._tiptapInstance.chain().focus();
            switch (styleConfig.style) {
                case 'bold': chain.toggleBold().run(); break;
                case 'italic': chain.toggleItalic().run(); break;
                case 'underline': chain.toggleUnderline().run(); break;
                case 'strike': chain.toggleStrike().run(); break;
                case 'code': chain.toggleCode().run(); break;
                case 'fontSize': styleConfig.value ? chain.setFontSize(styleConfig.value).run() : chain.unsetFontSize().run(); break;
                case 'bulletList': chain.toggleBulletList().run(); break;
                case 'orderedList': chain.toggleOrderedList().run(); break;
                case 'blockquote': chain.toggleBlockquote().run(); break;
                case 'codeBlock': chain.toggleCodeBlock().run(); break;
                case 'horizontalRule': chain.setHorizontalRule().run(); break;
                case 'undo': chain.undo().run(); break;
                case 'redo': chain.redo().run(); break;
                default: console.warn(`TiptapEditor.applyStyle: Unsupported style '${styleConfig.style}'`);
            }
        } catch (error) { this._logError(`applyStyle (${styleConfig.style})`, error); }
    }

    focus(position = 'end') {
        if (this.inactive()) return;
        try { this._tiptapInstance.commands.focus(position, { scrollIntoView: true }); }
        catch (error) { this._logError("focus", error); }
    }

    blur() {
        if (this.inactive()) return;
        try { this._tiptapInstance.commands.blur(); }
        catch (error) { this._logError("blur", error); }
    }

    hasFocus() {
        if (this.inactive()) return false;
        try { return this._tiptapInstance.isFocused; }
        catch (error) { this._logError("hasFocus", error); return false; }
    }

    destroy() {
        if (this._tiptapInstance && !this._tiptapInstance.isDestroyed) {
            try { this._tiptapInstance.destroy(); }
            catch (error) { this._logError("destroy", error); }
        }
        this._tiptapInstance = null; this._element = null; this._onChange = null;
        this._onSelectionUpdateCallback = null; this._dispatch = null; this._ontologyService = null; this._coreAPI = null;
    }

    isActive(name, attributes = {}) {
        if (this.inactive()) return false;
        try { return this._tiptapInstance.isActive(name, attributes); }
        catch (error) { this._logError(`isActive (${name})`, error); return false; }
    }

    can(command) {
        if (this.inactive()) return false;
        try { if (command === 'undo') return this._tiptapInstance.can().undo(); if (command === 'redo') return this._tiptapInstance.can().redo(); return true; }
        catch (error) { this._logError(`can (${command})`, error); return false; }
    }

    getAttributes(typeOrName) {
        if (this.inactive()) return {};
        try { return this._tiptapInstance.getAttributes(typeOrName); }
        catch (error) { this._logError(`getAttributes (${typeOrName})`, error); return {}; }
    }

    _logError(methodName, error) { console.error(`TiptapEditor.${methodName} Error:`, error); }
    inactive() { return !this._tiptapInstance || this._tiptapInstance.isDestroyed; }
}

// --- Suggestion Plugin ---
const suggestionPluginKey = new PluginKey('suggestionPlugin');

function SuggestionPlugin(dispatch) {
    let currentNoteId = null;
    let currentDecorationSet = DecorationSet.empty;
    let tippyInstances = [];
    const destroyTippyInstances = () => { tippyInstances.forEach(i => i?.destroy()); tippyInstances = []; };
    const createPopoverContent = (suggestion) => { /* ... (implementation unchanged) ... */
        const container = document.createElement('div');
        container.className = 'suggestion-popover';
        container.innerHTML = `
            <div class="suggestion-text"> Add property: <strong class="suggestion-key">${Utils.escapeHtml(suggestion.property.key)}</strong> = <em class="suggestion-value">${Utils.escapeHtml(suggestion.displayText || suggestion.property.value)}</em> <span class="suggestion-source" title="Source: ${Utils.escapeHtml(suggestion.source)}${suggestion.confidence ? ` | Confidence: ${Math.round(suggestion.confidence * 100)}%` : ''}"> (${Utils.escapeHtml(suggestion.source.replace('heuristic ', 'H:'))}${suggestion.confidence ? ` ${Math.round(suggestion.confidence * 100)}%` : ''}) </span> </div>
            <div class="suggestion-actions"> <button class="suggestion-confirm" title="Confirm">✓</button> <button class="suggestion-ignore" title="Ignore">✕</button> </div>
        `;
        container.querySelector('.suggestion-confirm').onmousedown = (e) => { e.preventDefault(); dispatch({ type: 'PARSER_CONFIRM_SUGGESTION', payload: { noteId: currentNoteId, suggestion } }); tippyInstances.find(inst => inst.reference === e.target.closest('.tippy-popper')?.previousSibling)?.hide(); };
        container.querySelector('.suggestion-ignore').onmousedown = (e) => { e.preventDefault(); dispatch({ type: 'PARSER_IGNORE_SUGGESTION', payload: { noteId: currentNoteId, suggestionId: suggestion.id } }); tippyInstances.find(inst => inst.reference === e.target.closest('.tippy-popper')?.previousSibling)?.hide(); };
        return container;
    };
    return new ProseMirrorPlugin({
        key: suggestionPluginKey,
        state: {
            init: () => ({ noteId: null, decorationSet: DecorationSet.empty }),
            apply(tr, pluginState) {
                const meta = tr.getMeta(suggestionPluginKey); let next = { ...pluginState };
                if (meta) { if (meta.noteId !== undefined) next.noteId = meta.noteId; if (meta.decorationSet !== undefined) next.decorationSet = meta.decorationSet; }
                // Only map decorations if the document changed
                if (tr.docChanged) {
                    next.decorationSet = next.decorationSet.map(tr.mapping, tr.doc);
                }
                currentNoteId = next.noteId; currentDecorationSet = next.decorationSet; return next;
            },
        },
        props: { decorations(state) { return this.getState(state)?.decorationSet ?? DecorationSet.empty; }, },
        view(editorView) {
            const store = window.realityNotebookCore; if (!store) { console.error("SuggestionPlugin: Core API not found."); return { destroy() { } }; }
            let prevJson = null;
            const unsub = store.subscribe((newState) => {
                const state = suggestionPluginKey.getState(editorView.state); const noteId = state?.noteId;
                if (!noteId) { if (currentDecorationSet !== DecorationSet.empty) { destroyTippyInstances(); if (!editorView.isDestroyed) editorView.dispatch(editorView.state.tr.setMeta(suggestionPluginKey, { decorationSet: DecorationSet.empty })); } prevJson = null; return; }
                const sugg = newState.pluginRuntimeState?.parser?.suggestions?.[noteId] || [];
                // Filter suggestions that are pending AND have a valid location
                const pending = sugg.filter(s => s.status === 'pending' && s.location && typeof s.location.start === 'number' && typeof s.location.end === 'number');
                const currJson = JSON.stringify(pending.map(s => ({ id: s.id, loc: s.location })));
                if (currJson !== prevJson) {
                    prevJson = currJson; destroyTippyInstances();
                    const decos = pending.flatMap(s => { /* ... (decoration creation unchanged) ... */
                        const { start, end } = s.location;
                        // Additional validation: Ensure location is within current document bounds
                        if (start >= end || start < 0 || end > editorView.state.doc.content.size) {
                             console.warn("SuggestionPlugin: Invalid or out-of-bounds suggestion location skipped.", { suggestionId: s.id, start, end, docSize: editorView.state.doc.content.size });
                             return [];
                        }
                        const hl = Decoration.inline(start, end, { class: 'suggestion-highlight', nodeName: 'span' });
                        const wd = Decoration.widget(end, () => { /* ... (widget creation unchanged) ... */
                            const btn = document.createElement('button'); btn.className = 'suggestion-action-button'; btn.textContent = '💡'; btn.dataset.suggestionId = s.id; btn.title = 'Suggested Property';
                            const tippyInst = tippy(btn, { content: createPopoverContent(s), allowHTML: true, interactive: true, trigger: 'click', placement: 'bottom-start', appendTo: () => editorView.dom.closest('.editor-container') || document.body, hideOnClick: true, theme: 'light-border', onShow(inst) { tippyInstances.filter(i => i !== inst && i?.state && !i.state.isDestroyed).forEach(i => i.hide()); }, onDestroy(inst) { tippyInstances = tippyInstances.filter(i => i !== inst); } });
                            tippyInstances.push(tippyInst); return btn;
                        }, { side: 1 }); return [hl, wd];
                    });
                    if (!editorView.isDestroyed) {
                        const tr = editorView.state.tr.setMeta(suggestionPluginKey, { decorationSet: DecorationSet.create(editorView.state.doc, decos) });
                        // Avoid dispatching if the view is already destroyed (can happen during rapid note switching)
                        if (!editorView.isDestroyed) {
                            editorView.dispatch(tr);
                        }
                    }
                }
            });
            return { destroy() { destroyTippyInstances(); unsub(); }, update(v, pS) { const nS = suggestionPluginKey.getState(v.state); const oS = suggestionPluginKey.getState(pS); if (nS?.noteId !== oS?.noteId) { destroyTippyInstances(); prevJson = null; } } };
        }
    });
}

// --- Toolbar Rendering Function ---
function renderToolbarContent(editorInstance) {
    if (!editorInstance || editorInstance.inactive()) return html`<span style="padding: 5px; font-style: italic; color: var(--secondary-text-color);">Editor loading...</span>`;
    const tiptap = editorInstance; const btnClass = (n, a = {}) => `toolbar-button ${tiptap.isActive(n, a) ? 'is-active' : ''}`; const currentFontSize = tiptap.getAttributes('textStyle')?.fontSize || '';
    return html`
        <button title="Undo (Ctrl+Z)" class="toolbar-button" @click=${() => tiptap.applyStyle({ style: 'undo' })} .disabled=${!tiptap.can('undo')}>↺</button>
        <button title="Redo (Ctrl+Y)" class="toolbar-button" @click=${() => tiptap.applyStyle({ style: 'redo' })} .disabled=${!tiptap.can('redo')}>↻</button> <span class="toolbar-divider"></span>
        <select title="Font Size" class="toolbar-select font-size-select" @change=${(e) => tiptap.applyStyle({ style: 'fontSize', value: e.target.value || null })}> <option value="">Font Size</option> ${TiptapEditor.FONT_SIZES.map(s => html`<option value="${s}" ?selected=${currentFontSize === s}>${s}</option>`)} </select> <span class="toolbar-divider"></span>
        <button title="Bold (Ctrl+B)" class=${btnClass('bold')} @click=${() => tiptap.applyStyle({ style: 'bold' })}><b>B</b></button> <button title="Italic (Ctrl+I)" class=${btnClass('italic')} @click=${() => tiptap.applyStyle({ style: 'italic' })}><i>I</i></button> <button title="Underline (Ctrl+U)" class=${btnClass('underline')} @click=${() => tiptap.applyStyle({ style: 'underline' })}><u>U</u></button> <button title="Strikethrough" class=${btnClass('strike')} @click=${() => tiptap.applyStyle({ style: 'strike' })}><s>S</s></button> <button title="Code" class=${btnClass('code')} @click=${() => tiptap.applyStyle({ style: 'code' })}>‹/›</button> <span class="toolbar-divider"></span>
        <button title="Bullet List" class=${btnClass('bulletList')} @click=${() => tiptap.applyStyle({ style: 'bulletList' })}>• List</button> <button title="Ordered List" class=${btnClass('orderedList')} @click=${() => tiptap.applyStyle({ style: 'orderedList' })}>1. List</button> <button title="Blockquote" class=${btnClass('blockquote')} @click=${() => tiptap.applyStyle({ style: 'blockquote' })}>" Quote</button> <button title="Code Block" class=${btnClass('codeBlock')} @click=${() => tiptap.applyStyle({ style: 'codeBlock' })}>{} Block</button> <button title="Horizontal Rule" class="toolbar-button" @click=${() => tiptap.applyStyle({ style: 'horizontalRule' })}>- Rule</button> <span class="toolbar-divider"></span>
        <button title="Insert Template" class="toolbar-button" @click=${() => RichTextEditorPlugin._handleInsertTemplate()}>📄 Insert</button> <button title="Generate Content via AI" class="toolbar-button llm-action-button" @click=${() => RichTextEditorPlugin._handleGenerateContent()}>✨ Generate</button>
    `;
}

// --- Rich Text Editor Plugin Definition ---
export const RichTextEditorPlugin = {
    id: 'richTextEditor',
    name: 'Rich Text Editor (Tiptap)',
    dependencies: ['properties', 'ontology', 'llm'],
    _editorInstance: null,
    _coreAPI: null,
    _currentNoteId: null,
    _toolbarUpdateQueued: false,
    _currentContentCache: '', // Cache of content *set* by the plugin or received from state
    _isUpdatingFromState: false, // Flag to indicate update comes from state, not user input

    init(coreAPI) { this.coreAPI = coreAPI; console.log(`${this.name}: Initialized.`); },
    onActivate() { console.log(`${this.name}: Activated. Editor creation deferred.`); },
    onDeactivate() { this._destroyEditor(); this._currentNoteId = null; this._currentContentCache = ''; console.log(`${this.name}: Deactivated.`); },

    _destroyEditor() {
        if (this._editorInstance && !this._editorInstance.inactive()) {
            try { this._editorInstance.destroy(); }
            catch (error) { console.error(`${this.name}: Error destroying instance:`, error); }
        }
        this._editorInstance = null;
        this._updateToolbarUI('destroyEditor');
    },

    _updateToolbarUI(trigger = 'unknown') {
        if (this._toolbarUpdateQueued) return; this._toolbarUpdateQueued = true;
        requestAnimationFrame(() => {
            const container = document.getElementById('editor-toolbar-container');
            if (container) litRender(renderToolbarContent(this._editorInstance), container);
            this._toolbarUpdateQueued = false;
        });
    },

    registerUISlots() {
        return {
            // This slot now ONLY renders the toolbar. The mount point is rendered by core.js.
            [SLOT_EDITOR_CONTENT_AREA]: (props) => {
                const { state, dispatch, noteId, coreAPI } = props;
                const note = noteId ? state.notes[noteId] : null;
                const debounceTime = 600; // Debounce time for saving user edits

                // Use requestAnimationFrame to defer DOM manipulation and editor logic
                // until after the main Lit render cycle for the current state update.
                requestAnimationFrame(() => {
                    const mountPoint = document.getElementById('editor-mount-point');
                    const toolbarContainer = document.getElementById('editor-toolbar-container');

                    if (!toolbarContainer) {
                         console.warn(`${this.name}: Toolbar container not found.`);
                         // Don't destroy editor if only toolbar is missing, but log it.
                    }
                    if (!mountPoint) {
                        // If mount point is missing, we can't have an editor. Destroy if exists.
                        console.warn(`${this.name}: Editor mount point not found. Destroying editor if active.`);
                        if (this._editorInstance && !this._editorInstance.inactive()) this._destroyEditor();
                        this._currentNoteId = null; // Ensure state reflects no active editor
                        this._currentContentCache = '';
                        return;
                    }

                    const currentInstanceExists = !!this._editorInstance && !this._editorInstance.inactive();
                    const editorShouldExist = !!note;
                    const noteChanged = currentInstanceExists && this._currentNoteId !== noteId;

                    // --- Editor Lifecycle Management ---

                    // 1. DESTROY: If no note selected OR note changed
                    if ((!editorShouldExist && currentInstanceExists) || noteChanged) {
                        // console.log(`Editor Lifecycle: Destroying editor (ShouldExist: ${editorShouldExist}, NoteChanged: ${noteChanged})`);
                        this._destroyEditor();
                        this._currentNoteId = null;
                        this._currentContentCache = '';
                        // Clear the mount point content manually ONLY if we are sure no editor should exist
                        if (!editorShouldExist) {
                            // mountPoint.innerHTML = ''; // Clear previous editor content
                        }
                        // Update toolbar state (will show 'loading' or similar)
                        this._updateToolbarUI('destroy');
                    }

                    // 2. CREATE: If note selected AND no active instance
                    if (editorShouldExist && (!this._editorInstance || this._editorInstance.inactive())) {
                        // console.log(`Editor Lifecycle: Creating editor for note ${noteId}`);
                        // Clear mount point before creating to ensure clean slate
                        // mountPoint.innerHTML = '';
                        try {
                            this._editorInstance = new TiptapEditor(mountPoint, {
                                content: note.content || '',
                                onSelectionUpdate: () => this._updateToolbarUI('selection'),
                                onChange: debounce(() => {
                                    // This callback is triggered by user edits (or programmatic changes that emit updates)
                                    if (!this._editorInstance || this._editorInstance.inactive() || !this._currentNoteId || this._isUpdatingFromState) return;

                                    const currentEditorContent = this._editorInstance.getContent();
                                    // Update cache *only* when user changes content
                                    this._currentContentCache = currentEditorContent;

                                    // Check against state *before* dispatching to avoid redundant updates
                                    const noteInState = coreAPI.getState().notes[this._currentNoteId];
                                    if (noteInState && currentEditorContent !== noteInState.content) {
                                        // console.log(`Editor onChange: Dispatching update for note ${this._currentNoteId}`);
                                        dispatch({ type: 'CORE_UPDATE_NOTE', payload: { noteId: this._currentNoteId, changes: { content: currentEditorContent } } });
                                    }
                                }, debounceTime),
                                editorOptions: {}, dispatch: dispatch, ontologyService: coreAPI.getService('OntologyService'), coreAPI: coreAPI
                            });
                            this._currentNoteId = noteId;
                            this._currentContentCache = note.content || ''; // Initialize cache
                            mountPoint.dataset.noteId = noteId; // Keep track on the element

                            // Sync suggestion plugin state after editor creation
                            Promise.resolve().then(() => {
                                if (this._editorInstance?._tiptapInstance?.view && this._editorInstance?._tiptapInstance?.state && !this._editorInstance.inactive()) {
                                    try {
                                        this._editorInstance._tiptapInstance.view.dispatch(
                                            this._editorInstance._tiptapInstance.state.tr.setMeta(suggestionPluginKey, { noteId: noteId })
                                        );
                                    } catch (dispatchError) {
                                         console.error("Error dispatching suggestion meta update after creation:", dispatchError);
                                    }
                                } else {
                                    console.warn("Editor view/state not ready for suggestion meta update after creation.");
                                }
                            });
                            this._updateToolbarUI('create'); // Update toolbar state
                        } catch (error) {
                            console.error(`${this.name}: Failed to init editor for note ${noteId}:`, error);
                            mountPoint.innerHTML = `<div style="color: red;">Editor Load Error! Check console.</div>`;
                            this._destroyEditor(); // Clean up failed instance
                        }
                    }
                    // 3. UPDATE: If note selected, instance exists, and note hasn't changed ID
                    else if (editorShouldExist && this._editorInstance && !this._editorInstance.inactive() && !noteChanged) {
                        // Check if the content in the state differs from our cached version
                        if (note.content !== this._currentContentCache) {
                            // Only update the editor if it doesn't currently have focus,
                            // to avoid overwriting active user edits.
                            if (!this._editorInstance.hasFocus()) {
                                // console.log(`Editor Lifecycle: Updating content for note ${noteId} from state (Editor not focused)`);
                                this._isUpdatingFromState = true; // Set flag before update
                                try {
                                    // Use Tiptap's `commands.setContent` method
                                    this._editorInstance.setContent(note.content || ''); // setContent now updates cache internally
                                    // Cache is updated inside setContent on success
                                } catch(error) {
                                    console.error(`${this.name}: Error during setContent in update block:`, error);
                                } finally {
                                    // Reset flag after update attempt
                                    requestAnimationFrame(() => { this._isUpdatingFromState = false; });
                                }
                            } else {
                                // console.log(`Editor Lifecycle: State content differs, but editor has focus. Skipping update for note ${noteId}.`);
                                // Content in state differs, but user is editing. The next save (onChange)
                                // from the user will eventually overwrite the state difference.
                                // OR, if the state change is critical, we might need a different strategy,
                                // but typically preserving user input is preferred.
                            }
                        }
                        // Ensure suggestion plugin has the correct noteId (might be redundant but safe)
                        const suggestionState = suggestionPluginKey.getState(this._editorInstance._tiptapInstance.state);
                        if (suggestionState?.noteId !== noteId) {
                             // console.log(`Editor Lifecycle: Syncing suggestion plugin noteId for ${noteId}`);
                             Promise.resolve().then(() => {
                                if (this._editorInstance?._tiptapInstance?.view && this._editorInstance?._tiptapInstance?.state && !this._editorInstance.inactive()) {
                                     try {
                                        this._editorInstance._tiptapInstance.view.dispatch(
                                            this._editorInstance._tiptapInstance.state.tr.setMeta(suggestionPluginKey, { noteId: noteId })
                                        );
                                     } catch (dispatchError) {
                                         console.error("Error dispatching suggestion meta update during sync:", dispatchError);
                                     }
                                }
                             });
                        }
                         // Always ensure toolbar reflects current editor state
                         this._updateToolbarUI('update');
                    }
                    // 4. NO EDITOR STATE: If no note is selected and no editor exists (already handled by destroy)
                    // This case is implicitly handled by the destroy logic above. If !editorShouldExist,
                    // the editor is destroyed. If it didn't exist anyway, nothing happens.
                    // We just need to ensure the toolbar is updated correctly.
                    else if (!editorShouldExist) {
                         this._updateToolbarUI('noEditor');
                    }

                }); // End requestAnimationFrame

                // --- Return ONLY the Toolbar HTML Structure ---
                // The editor itself is managed in the requestAnimationFrame callback above.
                return html`
                    <div class="editor-toolbar-container" style="flex-shrink: 0;"> <!-- Prevent toolbar from shrinking -->
                        <div id="editor-toolbar-container" class="editor-toolbar" role="toolbar" aria-label="Text Formatting">
                            <!-- Toolbar content rendered dynamically by _updateToolbarUI -->
                            ${renderToolbarContent(this._editorInstance)}
                        </div>
                    </div>
                    <style>
                        /* --- CSS Rules (Ensure ALL previous styles are pasted here) --- */

                        /* --- Editor Toolbar & Content Styles --- */
                        .editor-toolbar { display: flex; flex-wrap: wrap; align-items: center; padding: 4px 8px; border: 1px solid var(--border-color, #ccc); border-radius: 4px 4px 0 0; border-bottom: none; /* Remove bottom border as mount point has top border */
                            background-color: var(--toolbar-bg, #f8f9fa); /* Subtle background */
                            min-height: 34px;
                        }
                        .toolbar-button, .toolbar-select { border: 1px solid transparent; border-radius: 3px; padding: 4px 6px; margin: 2px; cursor: pointer; font-size: 1em; line-height: 1.2; min-width: 28px; text-align: center; color: var(--text-color, #333); vertical-align: middle; background-color: transparent; }
                        .toolbar-button:hover:not(:disabled) { background-color: var(--button-hover-bg, #e0e0e0); border-color: var(--border-color, #ccc); }
                        .toolbar-button.is-active { background-color: var(--accent-color-muted, #cce5ff); border-color: var(--accent-color, #99caff); color: var(--accent-text-color, #004085); }
                        .toolbar-button:disabled { opacity: 0.5; cursor: not-allowed; }
                        .toolbar-select { padding: 3px 4px; margin: 2px 4px; border: 1px solid var(--border-color, #ccc); background-color: var(--input-bg, #fff); color: var(--text-color, #333); font-size: 0.9em; max-width: 80px; }
                        .font-size-select { max-width: 85px; } /* Adjusted width for "Font Size" */
                        .toolbar-divider { display: inline-block; width: 1px; height: 20px; background-color: var(--border-color, #ccc); margin: 0 8px; vertical-align: middle; }
                        .llm-action-button { /* Style for AI buttons */ }

                        /* Tiptap Content Area (#editor-mount-point is styled in core.js now) */
                        /* Styles specific to the content *inside* the Tiptap editor */
                        .tiptap-editor-content .tiptap { outline: none; min-height: 150px; /* Ensure minimum height */ line-height: 1.6; color: var(--text-color); caret-color: var(--text-color); }
                        .tiptap-editor-content .tiptap > * + * { margin-top: 0.8em; }
                        .tiptap-editor-content .tiptap p { margin: 0; }
                        .tiptap-editor-content .tiptap ul, .tiptap-editor-content .tiptap ol { padding-left: 1.5rem; margin: 0.5em 0; }
                        .tiptap-editor-content .tiptap li > p { margin-bottom: 0.2em; }
                        .tiptap-editor-content .tiptap h1, .tiptap-editor-content .tiptap h2, .tiptap-editor-content .tiptap h3, .tiptap-editor-content .tiptap h4, .tiptap-editor-content .tiptap h5, .tiptap-editor-content .tiptap h6 { line-height: 1.3; margin: 1.2em 0 0.6em; font-weight: 600; }
                        .tiptap-editor-content .tiptap h1 { font-size: 2em; }
                        .tiptap-editor-content .tiptap h2 { font-size: 1.5em; }
                        .tiptap-editor-content .tiptap h3 { font-size: 1.25em; }

                        /* Inline Code */
                        .tiptap-editor-content .tiptap code:not(pre code) { background-color: var(--code-inline-bg, rgba(97, 97, 97, 0.1)); color: var(--code-inline-text, #616161); padding: .1em .3em; border-radius: .25em; font-size: 0.9em; font-family: var(--font-family-mono, monospace); }
                        /* Code Block */
                        .tiptap-editor-content .tiptap pre { background: var(--code-block-bg, #0D0D0D); color: var(--code-block-text, #FFF); font-family: var(--font-family-mono, monospace); white-space: pre-wrap; word-wrap: break-word; padding: 0.75rem 1rem; border-radius: 0.5rem; margin: 1em 0; overflow-x: auto; }
                        .tiptap-editor-content .tiptap pre code { color: inherit; padding: 0; background: none; font-size: 0.9em; display: block; }
                        /* Blockquote */
                        .tiptap-editor-content .tiptap blockquote { padding-left: 1rem; border-left: 3px solid var(--blockquote-border, rgba(13, 13, 13, 0.2)); margin: 1em 0; color: var(--blockquote-text, inherit); font-style: italic; }
                        /* Horizontal Rule */
                        .tiptap-editor-content .tiptap hr { border: none; border-top: 2px solid var(--hr-color, rgba(13, 13, 13, 0.1)); margin: 2rem 0; }
                        /* Placeholder Styling */
                        .tiptap-editor-content .tiptap p.is-editor-empty:first-child::before { content: attr(data-placeholder); float: left; color: var(--placeholder-text-color, #adb5bd); pointer-events: none; height: 0; }

                        /* --- Suggestion Highlight & Popover Styles --- */
                        .suggestion-highlight { background-color: var(--suggestion-highlight-bg, rgba(255, 255, 0, 0.3)); border-bottom: 1px dotted var(--suggestion-highlight-border, orange); }
                        .suggestion-action-button { display: inline-block; width: 16px; height: 16px; line-height: 16px; text-align: center; font-size: 12px; border: 1px solid var(--suggestion-button-border, #ccc); background-color: var(--suggestion-button-bg, #eee); color: var(--suggestion-button-text, #555); border-radius: 50%; margin-left: 2px; cursor: pointer; vertical-align: middle; padding: 0; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1); transition: background-color 0.2s ease; }
                        .suggestion-action-button:hover { background-color: var(--suggestion-button-hover-bg, #ddd); }
                        .tippy-box[data-theme~='light-border'] { border: 1px solid var(--border-color, #ccc); box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1); border-radius: 4px; }
                        .suggestion-popover { padding: 8px; font-size: 0.9em; line-height: 1.4; max-width: 300px; }
                        .suggestion-text { margin-bottom: 8px; word-break: break-word; }
                        .suggestion-key { font-weight: bold; color: var(--accent-color, blue); }
                        .suggestion-value { font-style: italic; color: var(--secondary-text-color, #555); }
                        .suggestion-source { font-size: 0.85em; color: var(--secondary-text-color, #777); margin-left: 5px; opacity: 0.8; white-space: nowrap; }
                        .suggestion-actions { display: flex; justify-content: flex-end; gap: 5px; margin-top: 5px; border-top: 1px solid var(--border-color, #eee); padding-top: 5px; }
                        .suggestion-actions button { background: none; border: 1px solid transparent; cursor: pointer; font-size: 1.3em; padding: 0 4px; border-radius: 3px; line-height: 1; }
                        .suggestion-actions button:hover { background-color: var(--hover-background-color, #f0f0f0); border-color: var(--border-color, #ccc); }
                        .suggestion-confirm { color: var(--success-color, green); }
                        .suggestion-ignore { color: var(--danger-color, red); }

                        /* Inline Property Node Styles */
                        .inline-property { display: inline-block; border: 1px solid var(--inline-prop-border-color, #ddd); background-color: var(--inline-prop-bg, #f7f7f7); border-radius: 4px; padding: 1px 6px; margin: 0 2px; font-size: 0.9em; white-space: nowrap; cursor: pointer; transition: background-color 0.2s ease, border-color 0.2s ease; user-select: none; vertical-align: baseline; }
                        .inline-property:hover { background-color: var(--inline-prop-hover-bg, #eee); border-color: var(--inline-prop-hover-border, #ccc); }
                        .inline-property-key { font-weight: bold; color: var(--inline-prop-key-color, #333); margin-right: 4px; }
                        .inline-property-value { color: var(--inline-prop-value-color, #555); }
                        .inline-property-icon { margin-right: 4px; font-size: 0.9em; opacity: 0.8; }
                        .ProseMirror-selectednode .inline-property { background-color: var(--accent-color-muted, #d6eaff); border-color: var(--accent-color, #5b9dd9); box-shadow: 0 0 0 1px var(--accent-color, #5b9dd9); }

                    </style>
                `;
            }
        };
    }, // End registerUISlots

    providesServices() {
        return {
            'EditorService': {
                getContent: () => this._editorInstance?.getContent() ?? '',
                setContent: (content) => this._editorInstance?.setContent(content),
                getSelection: () => this._editorInstance?.getSelection() ?? null,
                getSelectedText: () => this._editorInstance?.getSelectedText() ?? '',
                insertContentAtCursor: (content) => this._editorInstance?.insertContentAtCursor(content),
                applyStyle: (styleConfig) => this._editorInstance?.applyStyle(styleConfig),
                focus: (position) => this._editorInstance?.focus(position),
                blur: () => this._editorInstance?.blur(),
                hasFocus: () => this._editorInstance?.hasFocus() ?? false,
                isEditorActive: () => !!this._editorInstance && !this._editorInstance.inactive(),
                replaceTextWithInlineProperty: (location, propData) => {
                    if (this._editorInstance && !this._editorInstance.inactive() && location && propData) {
                        try {
                            this._editorInstance._tiptapInstance?.chain().focus().setTextSelection(location)
                                .insertContent({ type: InlineProperty.name, attrs: { propId: propData.propId, key: propData.key, value: propData.value, type: propData.type, } }).run();
                        } catch (error) {
                            console.error("EditorService.replaceTextWithInlineProperty Error:", error, { location, propData });
                            this.coreAPI?.showGlobalStatus("Error replacing text with property.", "error");
                        }
                    } else { console.warn("EditorService.replaceTextWithInlineProperty: Invalid args or editor inactive.", { location, propData }); }
                },
            }
        };
    }, // End providesServices

    registerMiddleware() {
        const pluginInstance = this;
        return storeApi => next => action => {
            if (action.type === 'TEMPLATE_SELECTED') {
                const { template, context } = action.payload;
                if (context === 'insert') pluginInstance._insertTemplateContent(template);
                else if (context === 'generate') pluginInstance._generateContentFromTemplate(template);
            }
            return next(action);
        };
    }, // End registerMiddleware

    async _generateContentFromTemplate(selectedTemplate) { /* ... (implementation unchanged) ... */
        if (!this.coreAPI || !this._editorInstance || this._editorInstance.inactive() || !this._currentNoteId || !selectedTemplate) return;
        const llmService = this.coreAPI.getService('LLMService'); const propertiesAPI = this.coreAPI.getPluginAPI('properties');
        if (!llmService || !propertiesAPI) return this.coreAPI.showGlobalStatus("Cannot generate: Service unavailable.", "warning");
        const currentProperties = propertiesAPI.getPropertiesForNote(this._currentNoteId) || []; this.coreAPI.showGlobalStatus(`Generating content: "${selectedTemplate.name}"...`, "info");
        try { const generatedContent = await llmService.generateContent(selectedTemplate.name, currentProperties); if (generatedContent) { this.providesServices().EditorService.insertContentAtCursor?.(generatedContent); this.coreAPI.showGlobalStatus("AI content generated.", "success", 3000); } else { this.coreAPI.showGlobalStatus("AI content generation returned empty.", "info", 4000); } }
        catch (error) { console.error(`${this.name}: Error generating content:`, error); this.coreAPI.showGlobalStatus(`Error generating content: ${error.message}`, "error", 5000); }
    },

    _handleGenerateContent() { /* ... (implementation unchanged) ... */
        if (!this.coreAPI) return; const ontologyService = this.coreAPI.getService('OntologyService'); const llmService = this.coreAPI.getService('LLMService');
        if (!ontologyService || !llmService || !this._editorInstance || this._editorInstance.inactive()) return this.coreAPI.showGlobalStatus("Cannot generate: Service/Editor unavailable.", "warning");
        const templates = ontologyService.getTemplates()?.filter(t => t.context?.includes('generate')); if (!templates || templates.length === 0) return this.coreAPI.showGlobalStatus("No generation templates found.", "info");
        this.coreAPI.dispatch({ type: 'CORE_OPEN_MODAL', payload: { modalType: 'templateSelector', modalProps: { templates, context: 'generate', onSelectActionType: 'TEMPLATE_SELECTED' } } });
    },

    _insertTemplateContent(template) { /* ... (implementation unchanged) ... */
        const editorService = this.providesServices().EditorService; if (!this.coreAPI || !editorService.isEditorActive() || !template) return this.coreAPI?.showGlobalStatus("Cannot insert template.", "warning");
        try { let content = template.content || ''; const sel = editorService.getSelectedText() || ''; const note = this.coreAPI.getSelectedNote();
            const reps = { '{{date}}': Utils.formatDate(Date.now()).split(',')[0], '{{time}}': new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), '{{datetime}}': Utils.formatDate(Date.now()), '{{selectedText}}': sel, '{{noteName}}': note?.name || 'Untitled', };
            Object.entries(reps).forEach(([p, v]) => { content = content.replace(new RegExp(Utils.escapeRegex(p), 'gi'), v); });
            editorService.insertContentAtCursor(content); this.coreAPI.showGlobalStatus(`Template "${template.name}" inserted.`, "success", 2000); }
        catch (error) { console.error(`${this.name}: Error inserting template:`, error); this.coreAPI.showGlobalStatus(`Error inserting template: ${error.message}`, "error", 4000); }
    },

    _handleInsertTemplate() { /* ... (implementation unchanged) ... */
        if (!this.coreAPI) return; const ontologyService = this.coreAPI.getService('OntologyService');
        if (!ontologyService || !this._editorInstance || this._editorInstance.inactive()) return this.coreAPI.showGlobalStatus("Cannot insert: Service/Editor unavailable.", "warning");
        const templates = ontologyService.getTemplates()?.filter(t => !t.context || t.context?.includes('insert')); if (!templates || templates.length === 0) return this.coreAPI.showGlobalStatus("No insertion templates found.", "info");
        this.coreAPI.dispatch({ type: 'CORE_OPEN_MODAL', payload: { modalType: 'templateSelector', modalProps: { templates, context: 'insert', onSelectActionType: 'TEMPLATE_SELECTED' } } });
    },

}; // End RichTextEditorPlugin definition
