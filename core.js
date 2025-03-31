"use strict";

import localforage from "localforage";
import {produce} from "immer";

import {Utils} from './util.js';
import {EventBus} from './event.js';
import {
    SLOT_APP_STATUS_BAR,
    SLOT_EDITOR_BELOW_CONTENT,
    SLOT_EDITOR_CONTENT_AREA,
    SLOT_EDITOR_HEADER_ACTIONS,
    SLOT_EDITOR_PLUGIN_PANELS,
    SLOT_NOTE_LIST_ITEM_META,
    SLOT_NOTE_LIST_ITEM_STATUS,
    SLOT_SETTINGS_PANEL_SECTION,
    SLOT_SIDEBAR_HEADER,
    SLOT_SIDEBAR_NOTE_LIST_ACTIONS
} from './ui.js';


//Plugins
import {PropertiesPlugin} from './property.js';
import {OntologyPlugin} from './ontology.js';
import {SemanticParserPlugin} from "./parser.js";
import {RichTextEditorPlugin} from "./editor.js";
import {NostrPlugin} from "./nostr.js";
import {LLMPlugin} from "./llm.js";
import {MatcherPlugin} from "./matcher.js"; // Import MatcherPlugin
const PLUGINS = [
    PropertiesPlugin,
    OntologyPlugin,
    SemanticParserPlugin,
    RichTextEditorPlugin,
    NostrPlugin,
    LLMPlugin,
    MatcherPlugin // Add MatcherPlugin to the list
];


const {html, render} = window.litHtml;

// --- 3. Core State Manager (with Immer) ---
class StateManager {
    _state = {};
    _coreReducer = null; // Single core reducer function
    _pluginReducers = new Map(); // Map<pluginId, reducerFn>
    _middleware = [];
    _listeners = new Set();
    _dispatchChain = null;
    _isDispatching = false; // Prevent re-entrant dispatches

    constructor(initialState, coreReducer) {
        this._state = initialState; // Assume initialState is already structured correctly
        if (typeof coreReducer !== 'function')
            throw new Error("State: coreReducer must be a function.");

        this._coreReducer = coreReducer;
        this._dispatchChain = this._buildDispatchChain();
        console.log("StateManager initialized.");
    }

    getState() {
        // Return the current state. Convention is to treat it as immutable outside reducers.
        return this._state;
    }

    subscribe(listener) {
        if (typeof listener !== 'function') {
            console.error("State: Listener is not a function.");
            return () => {
            };
        }
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    _notifyListeners(oldState) {
        this._listeners.forEach(listener => {
            try {
                listener(this._state, oldState);
            } catch (error) {
                console.error("State: Error in listener during notification.", error);
            }
        });
    }

    getStoreApi() {
        return {
            getState: () => this.getState(),
            dispatch: (action) => this._dispatchChain(action), // Use the composed chain
        };
    }

    _buildDispatchChain() {
        // console.log(`State: Rebuilding dispatch chain with ${this._middleware.length} middleware.`);
        return this._middleware.reduceRight(
            (next, mw) => mw(this.getStoreApi())(next),
            this._baseDispatch.bind(this)
        );
    }

    // --- Immer Integration in _baseDispatch ---
    _baseDispatch(action) {
        if (this._isDispatching) {
            console.warn(`State: Concurrent dispatch detected for action [${action.type}]. Action ignored.`);
            return action;
        }
        this._isDispatching = true;

        const oldState = this._state;
        let nextState = oldState;

        try {
            // Use Immer's produce to handle immutable updates
            nextState = produce(oldState, draft => {
                // Apply core reducer (mutates draft)
                try {
                    this._coreReducer(draft, action);
                } catch (error) {
                    console.error(`State: Error in core reducer for action [${action.type}]`, error, action);
                    // Optionally revert draft changes or dispatch error? Immer handles draft consistency.
                }

                // Apply all plugin reducers (mutates draft)
                this._pluginReducers.forEach((reducerFn, pluginId) => {
                    try {
                        reducerFn(draft, action);
                    } catch (error) {
                        console.error(`State: Error in plugin reducer for [${pluginId}] on action [${action.type}]`, error, action);
                    }
                });
            }); // Immer returns the new state if changes were made, or oldState if not

        } catch (error) {
            console.error("State: Error during Immer produce or reducer execution.", error, action);
            // If produce itself fails, nextState remains oldState
            nextState = oldState;
        } finally {
            this._isDispatching = false;
        }

        // Only update and notify if the state object reference has changed
        if (nextState !== oldState) {
            this._state = nextState;
            this._notifyListeners(oldState);
        }
        return action; // Return the action (standard middleware pattern)
    }

    dispatch(action) {
        if (!action || typeof action.type !== 'string') {
            console.error("State: Invalid action dispatched. Action must be an object with a 'type' property.", action);
            return undefined; // Indicate failure or do nothing
        }
        return this._dispatchChain(action);
    }

    // --- Methods called by PluginManager ---
    registerReducer(pluginId, reducerFn) {
        if (typeof reducerFn !== 'function') {
            console.error(`State: Attempted to register non-function reducer for plugin [${pluginId}].`);
            return;
        }
        if (this._pluginReducers.has(pluginId)) {
            console.warn(`State: Reducer already registered for plugin [${pluginId}]. Overwriting.`);
        }
        this._pluginReducers.set(pluginId, reducerFn);
        console.log(`State: Registered main reducer for plugin [${pluginId}]`);
    }

    registerMiddleware(pluginId, middlewareFn) {
        if (typeof middlewareFn !== 'function') {
            console.error(`State: Attempted to register non-function middleware for plugin [${pluginId}].`);
            return;
        }
        this._middleware.push(middlewareFn);
        this._dispatchChain = this._buildDispatchChain(); // Rebuild chain immediately
        console.log(`State: Registered middleware from plugin [${pluginId}]`);
    }
}

// --- 4. Core Persistence Service ---
class PersistenceService {
    _stateManager = null;
    _isSaving = false;
    _storageKey = 'realityNotebookAppState_v10.1_core'; // Unique key
    _localForage = null;

    constructor(stateManager) {
        this._stateManager = stateManager;
        if (typeof localforage === 'undefined') {
            console.error("PersistenceService Error: localforage library not found. Persistence is disabled.");
            this._localForage = null;
            // Optionally show a persistent error to the user via state
            stateManager.dispatch({
                type: 'CORE_SET_GLOBAL_STATUS',
                payload: {message: "Error: Cannot save data (Storage library missing).", type: 'error', duration: 0}
            });
        } else {
            this._localForage = localforage;
            this._localForage.config({
                name: 'RealityNotebook',
                storeName: 'appState_v10_1', // Specific store name
                description: 'Stores Netention application state'
            });
            // Debounced subscription to state changes for saving
            this._stateManager.subscribe(Utils.debounce(this._handleStateChange.bind(this), 1200));
            console.log("PersistenceService initialized with localForage.");
        }
    }

    async loadState() {
        if (!this._localForage) return Promise.resolve(null); // Return null if no storage
        try {
            console.log(`PersistenceService: Loading state '${this._storageKey}'...`);
            const savedState = await this._localForage.getItem(this._storageKey);
            if (savedState) {
                console.log('PersistenceService: State loaded successfully.');
                // TODO: Implement state migration logic here if versions differ significantly
            } else {
                console.log('PersistenceService: No saved state found.');
            }
            return savedState || null; // Return null if nothing found
        } catch (error) {
            console.error('PersistenceService: Error loading state', error);
            this._stateManager.dispatch({
                type: 'CORE_SET_GLOBAL_STATUS',
                payload: {message: "Error loading saved data.", type: 'error', duration: 10000}
            });
            return null; // Return null on error
        }
    }

    async _handleStateChange(newState) {
        if (!this._localForage) return; // Don't save if storage isn't available
        await this.saveState(newState);
    }

    async saveState(state) {
        if (!this._localForage) return;
        if (this._isSaving) return; // Avoid concurrent saves

        this._isSaving = true;
        try {
            const stateToSave = this.filterStateForSaving(state);
            await this._localForage.setItem(this._storageKey, stateToSave);
            // console.log('PersistenceService: State saved successfully.'); // Can be noisy
        } catch (error) {
            console.error('PersistenceService: Error saving state', error);
            this._stateManager.dispatch({
                type: 'CORE_SET_GLOBAL_STATUS',
                payload: {message: "Error saving data.", type: 'error', duration: 10000}
            });
        } finally {
            this._isSaving = false;
        }
    }

    filterStateForSaving(state) {
        // Explicitly exclude transient state slices using destructuring
        const {
            uiState,             // Exclude all transient UI state
            pluginRuntimeState,  // Exclude all plugin runtime state
            ...stateToSave        // Keep the rest (notes, noteOrder, settings, runtimeCache, systemNoteIndex)
        } = state;
        // No deep cloning needed here as Immer ensures upstream immutability,
        // and localForage handles serialization.
        return stateToSave;
    }

    async clearState() {
        if (!this._localForage) {
            console.warn("PersistenceService: Cannot clear state, localForage not available.");
            return;
        }
        console.warn("PersistenceService: Clearing all persistent application state!");
        try {
            await this._localForage.removeItem(this._storageKey);
            console.log("PersistenceService: Application state cleared from localForage.");
            // Optionally dispatch an action or reload
            this._stateManager.dispatch({type: 'CORE_STATE_CLEARED'}); // Inform the app
        } catch (error) {
            console.error("PersistenceService: Error clearing state.", error);
            this._stateManager.dispatch({
                type: 'CORE_SET_GLOBAL_STATUS',
                payload: {message: "Error clearing data.", type: 'error', duration: 10000}
            });
        }
    }
}

class UIRenderer {
    _stateManager = null;
    _rootElement = null;
    _slotRegistry = new Map();
    _scrollPositions = {};
    _ontologyService = null; // Cache ontology service

    constructor(stateManager, rootElementId = 'app') {
        this._stateManager = stateManager;
        this._rootElement = document.getElementById(rootElementId);
        if (!this._rootElement) {
            throw new Error(`UIRenderer Critical Error: Root element with ID '${rootElementId}' not found!`);
        }
        // Subscribe to state changes to trigger re-renders
        this._stateManager.subscribe(this._scheduleRender.bind(this));
        // Cache ontology service on init
        // Note: CoreAPI might not be fully ready here. Better to get it lazily.
        // this._ontologyService = window.realityNotebookCore?.getService('OntologyService');
        console.log("UIRenderer initialized with lit-html.");
    }

    // Lazy getter for Ontology Service
    _getOntologyService() {
        if (!this._ontologyService) {
            this._ontologyService = window.realityNotebookCore?.getService('OntologyService');
        }
        return this._ontologyService;
    }


    _scheduleRender(newState) {
        // Use requestAnimationFrame to batch renders for performance
        requestAnimationFrame(() => this.renderApp(newState));
    }

    renderApp(state = this._stateManager.getState()) {
        // console.time("renderApp"); // Performance profiling
        this._saveScrollPositions(); // Save scroll before potentially changing DOM structure

        try {
            // Render the main VDOM tree using lit-html's render function
            render(this._renderMainVdomTree(state), this._rootElement);
        } catch (error) {
            console.error("UIRenderer: CRITICAL ERROR during renderApp!", error);
            // Render an error message directly using lit-html
            render(html`
                <div class="error-display">
                    <h1>Application Render Error</h1>
                    <p>An unexpected error occurred while rendering the UI.</p>
                    <pre>${Utils.sanitizeHTML(error.stack)}</pre>
                    <p>Please check the console for details. You may need to reload or clear application data.</p>
                </div>`, this._rootElement);
        } finally {
            this._restoreScrollPositions(); // Restore scroll after DOM updates
            // console.timeEnd("renderApp");
        }
    }

    _renderMainVdomTree(state) {
        // Apply theme data attribute directly here
        document.documentElement.setAttribute('data-theme', state.settings.core.theme || 'light');

        const selectedNote = state.uiState.selectedNoteId ? state.notes[state.uiState.selectedNoteId] : null;
        const globalStatus = state.uiState.globalStatus;

        return html`
            <div class="app-container">
                <div id="sidebar" class="sidebar">
                    <div class="sidebar-header">
                        <button id="core-open-settings" title="Settings" @click=${this._handleOpenSettings}
                                aria-label="Open Settings">⚙️
                        </button>
                        <input type="search" id="core-search" placeholder="Search..."
                               .value=${state.uiState.searchTerm || ''} @input=${this._handleSearchInput}
                               aria-label="Search Notes">
                        <!-- Slot for plugin buttons -->
                        <div data-slot="${SLOT_SIDEBAR_HEADER}">${this._renderSlot(state, SLOT_SIDEBAR_HEADER)}
                        </div>
                    </div>
                    <div class="sidebar-actions">
                        <button id="core-add-note" title="Add New Note" @click=${this._handleAddNote}>➕ Add Note
                        </button>
                        <!-- Sort Control -->
                        <select id="core-note-sort" title="Sort Notes By" @change=${this._handleSortChange}
                                .value=${state.uiState.noteListSortMode || 'time'}>
                            <option value="time">Sort: Time</option>
                            <option value="priority">Sort: Priority</option>
                        </select>
                        <!-- Slot for actions below Add Note -->
                        <div data-slot="${SLOT_SIDEBAR_NOTE_LIST_ACTIONS}">
                            ${this._renderSlot(state, SLOT_SIDEBAR_NOTE_LIST_ACTIONS)}
                        </div>
                    </div>
                    <ul id="note-list" class="note-list" @keydown=${this._handleNoteListKeyDown}
                        aria-label="Note List">
                        ${this._renderNoteListItems(state)}
                    </ul>
                </div>
                <div id="main-content-area" class="main-content-area">
                    <div id="editor-area" class="editor-area" role="main" aria-live="polite">
                        ${selectedNote ? this._renderEditorArea(state, selectedNote) : this._renderWelcomeMessage(state)}
                    </div>
                    <div id="status-bar" class="status-bar" role="status">
                                <span class="core-status ${globalStatus?.type || 'info'}"
                                      title=${globalStatus?.message || ''}>
                                    ${globalStatus?.message || 'Ready'}
                                </span>
                        <div data-slot="${SLOT_APP_STATUS_BAR}">${this._renderSlot(state, SLOT_APP_STATUS_BAR)}
                        </div>
                    </div>
                </div>
                <div id="modal-root">
                    ${this._renderModal(state)}
                </div>
            </div>
            <style>
                .validation-error {
                    color: var(--danger-color, red);
                    font-size: 0.85em;
                    margin-top: 4px;
                    min-height: 1em; /* Reserve space */
                }
                .modal-content input:invalid, .modal-content select:invalid { /* Basic browser validation indication */
                     border-color: var(--danger-color, red);
                }
                /* Style inputs with server-side validation errors */
                 .modal-content input[aria-invalid="true"],
                 .modal-content select[aria-invalid="true"] {
                    border-color: var(--danger-color, red);
                    outline: 1px solid var(--danger-color, red);
                 }
            </style>
        `;
    }

    _renderNoteListItems(state) {
        const {notes, noteOrder, uiState} = state;
        const {selectedNoteId, searchTerm, noteListSortMode = 'time'} = uiState;

        // --- Enhanced Filtering Logic ---
        const {textQuery, structuredFilters} = this._parseSearchQuery(searchTerm || '');
        const lowerTextQuery = textQuery.toLowerCase();

        // 1. Filter notes based on text and structured queries
        let filteredNoteIds = noteOrder.filter(id => {
            const note = notes[id];
            if (!note || note.isArchived) return false;

            // Text search match (if text query exists)
            const textMatch = !lowerTextQuery ||
                (note.name.toLowerCase().includes(lowerTextQuery) ||
                    note.content.toLowerCase().includes(lowerTextQuery));

            // Structured filter match (if filters exist)
            const properties = note.pluginData?.properties?.properties || [];
            const structuredMatch = structuredFilters.length === 0 ||
                this._evaluateStructuredFilters(properties, structuredFilters);

            // Must match both (if they exist)
            return textMatch && structuredMatch;
        });
        // --- End Enhanced Filtering Logic ---


        // 2. Sort filtered notes
        const getPriority = (noteId) => {
            const note = notes[noteId];
            const props = note?.pluginData?.properties?.properties || [];
            const priorityProp = props.find(p => p.key?.toLowerCase() === 'priority');
            // Default to a mid-range priority (e.g., 5) if not found or invalid
            return priorityProp ? (parseInt(priorityProp.value, 10) || 5) : 5;
        };

        filteredNoteIds.sort((a, b) => {
            if (noteListSortMode === 'priority') {
                // Sort by priority descending (higher first)
                return getPriority(b) - getPriority(a);
            } else { // Default to 'time'
                // Sort by updatedAt descending (newer first)
                return (notes[b]?.updatedAt || 0) - (notes[a]?.updatedAt || 0);
            }
        });

        // 3. Render sorted list
        if (filteredNoteIds.length === 0) {
            return html`
                <li style="padding: 1rem; color: var(--secondary-text-color);">
                    ${searchTerm ? 'No matching notes.' : 'No notes yet.'}
                </li>`;
        }

        return filteredNoteIds.map(noteId => {
            const note = notes[noteId];
            const isSelected = noteId === selectedNoteId;
            return html`
                <li
                        class="note-list-item ${isSelected ? 'selected' : ''}"
                        data-note-id="${noteId}"
                        role="option"
                        tabindex="0"
                        aria-selected="${isSelected}"
                        @click=${() => this._handleSelectNote(noteId)}
                        title=${`Updated: ${Utils.formatDate(note.updatedAt)}`}
                >
                    <div class="note-list-item-title">${note.name || 'Untitled Note'}</div>
                    <div class="note-list-item-meta">
                            <span data-slot="${SLOT_NOTE_LIST_ITEM_META}"
                                  data-note-id=${noteId}>${this._renderSlot(state, SLOT_NOTE_LIST_ITEM_META, noteId)}</span>
                    </div>
                    <div class="note-list-item-status" data-slot="${SLOT_NOTE_LIST_ITEM_STATUS}"
                         data-note-id=${noteId}>
                        ${this._renderSlot(state, SLOT_NOTE_LIST_ITEM_STATUS, noteId)}
                    </div>
                </li>
            `;
        });
    }

    _renderEditorArea(state, note) {
        const slotContent = this._renderSlot(state, SLOT_EDITOR_CONTENT_AREA, note.id);
        const hasPluginContent = Array.isArray(slotContent)
            ? slotContent.some(item => item != null && item !== '')
            : (slotContent != null && slotContent !== '');

        return html`
            <div class="editor-header" data-note-id=${note.id}>
                <input
                        type="text"
                        class="editor-title-input"
                        .value=${note.name}
                        placeholder="Note Title"
                        aria-label="Note Title"
                        @input=${this._handleTitleInput(note.id)}
                >
                <div class="editor-header-actions" data-slot="${SLOT_EDITOR_HEADER_ACTIONS}" data-note-id=${note.id}>
                    <button class="core-archive-note" @click=${this._handleArchiveNote(note.id)}
                            title="Archive Note" aria-label="Archive Note">Archive
                    </button>
                    <button class="core-delete-note" @click=${this._handleDeleteNote(note.id, note.name)}
                            title="Delete Note" aria-label="Delete Note">Delete
                    </button>
                    ${this._renderSlot(state, SLOT_EDITOR_HEADER_ACTIONS, note.id)}
                    <!-- LLM Action Buttons -->
                    <button class="editor-header-button llm-action-button"
                            @click=${() => this._handleLlmSummarize(note.id)} title="Summarize selection or note">
                        Summarize
                    </button>
                    <button class="editor-header-button llm-action-button"
                            @click=${() => this._handleLlmAskQuestion(note.id)} title="Ask question about note content">
                        Ask
                    </button>
                    <button class="editor-header-button llm-action-button"
                            @click=${() => this._handleLlmGetActions(note.id)}
                            title="Suggest actions based on note content">Actions
                    </button>
                </div>
            </div>
            <div class="editor-content-wrapper"
                 style="flex-grow: 1; display: flex; flex-direction: column; overflow: hidden;">
                ${hasPluginContent ? html`
                    <div class="editor-content-area plugin-controlled" data-slot="${SLOT_EDITOR_CONTENT_AREA}"
                         data-note-id=${note.id}
                         style="flex-grow: 1; display: flex; flex-direction: column; overflow-y: auto;">
                        ${slotContent}
                    </div>` : html`
                    <div class="editor-content-area core-controlled"
                         style="flex-grow: 1; display: flex; flex-direction: column;">
                        <textarea
                                class="core-content-editor"
                                aria-label="Note Content"
                                placeholder="Start writing..."
                                .value=${note.content}
                                @input=${this._handleContentInput(note.id)}
                                style="flex-grow: 1; width: 100%; border: none; padding: 10px; font-family: inherit; font-size: inherit; resize: none; outline: none;"
                        ></textarea>
                    </div>`}
            </div>
            <div class="editor-below-content" data-slot="${SLOT_EDITOR_BELOW_CONTENT}" data-note-id=${note.id}>
                ${this._renderSlot(state, SLOT_EDITOR_BELOW_CONTENT, note.id)}
            </div>
            <div class="editor-plugin-panels" data-slot="${SLOT_EDITOR_PLUGIN_PANELS}" data-note-id=${note.id}>
                ${this._renderSlot(state, SLOT_EDITOR_PLUGIN_PANELS, note.id)}
            </div>
        `;
    }

    _renderWelcomeMessage(state) {
        const noteCount = state.noteOrder.filter(id => !state.notes[id]?.isArchived).length;
        const message = noteCount > 0
            ? `Select a note or click "➕ Add Note".`
            : `Click "➕ Add Note" to get started!`;
        return html`
            <div class="welcome-message">
                <h2>Welcome!</h2>
                <p>${message}</p>
            </div>`;
    }

    _renderSettingsModal(state) {
        return html`
            <div id="modal-backdrop" class="modal-backdrop" @click=${this._handleCloseModal}></div>
            <div id="settings-view" class="modal-content settings-view" role="dialog" aria-modal="true"
                 aria-labelledby="settings-title">
                <button id="core-close-settings" class="modal-close-button" @click=${this._handleCloseModal}
                        aria-label="Close Settings" title="Close Settings">×
                </button>
                <h2 id="settings-title">Settings</h2>
                <div class="settings-core">
                    <h3>Core Settings</h3>
                    <label for="core-theme-select">Theme:</label>
                    <select id="core-theme-select" data-setting-key="theme"
                            @change=${this._handleCoreSettingChange}>
                        <option value="light" ?selected=${state.settings.core.theme === 'light'}>Light</option>
                        <option value="dark" ?selected=${state.settings.core.theme === 'dark'}>Dark</option>
                    </select>
                </div>
                <div class="settings-plugins">
                    <!-- Settings Generation Enhancement (#0) -->
                    <!-- Core provides the slot, but individual plugins now render -->
                    <!-- their own forms based on their getSettingsOntology() -->
                    <!-- and reading properties from their config System Note -->
                    <!-- This section title remains, but the rendering logic -->
                    <!-- inside the slot functions (e.g., in llm.js, nostr.js) changes -->
                    <h3>Plugin Settings</h3>
                    <div data-slot="${SLOT_SETTINGS_PANEL_SECTION}">
                        ${this._renderSlot(state, SLOT_SETTINGS_PANEL_SECTION)}
                        ${!this._slotRegistry.has(SLOT_SETTINGS_PANEL_SECTION) || this._slotRegistry.get(SLOT_SETTINGS_PANEL_SECTION).length === 0
                                ? html`<p style="color: var(--secondary-text-color)">No plugin settings
                                    available.</p>`
                                : ''}
                    </div>
                </div>
            </div>
            </div>
        `;
    }

    _renderSlot(state, slotName, noteId = null) {
        const components = this._slotRegistry.get(slotName) || [];
        if (components.length === 0) return '';

        return components.map(({pluginId, renderFn}) => {
            try {
                const props = {
                    state,
                    dispatch: this._stateManager.dispatch.bind(this._stateManager),
                    coreAPI: window.realityNotebookCore, // Provide Core API
                    noteId: noteId || state.uiState.selectedNoteId || null,
                    html, // Pass lit-html tag function if needed by plugin
                };
                // Assuming renderFn returns a lit-html TemplateResult
                return renderFn(props);
            } catch (error) {
                console.error(`UIRenderer: Error rendering slot [${slotName}] by plugin [${pluginId}]`, error);
                return html`
                    <div style="color:var(--danger-color); font-size: 0.8em;">! Err:${pluginId}</div>`;
            }
        });
    }

    // --- LLM Action Handlers ---
    async _handleLlmSummarize(noteId) {
        const coreAPI = window.realityNotebookCore;
        const editorService = coreAPI?.getService('EditorService');
        const llmService = coreAPI?.getService('LLMService');
        if (!editorService || !llmService) return coreAPI?.showGlobalStatus("LLM/Editor service not ready.", "warning");

        const selectedText = editorService.getSelectedText();
        const textToSummarize = selectedText || editorService.getContent(); // Summarize selection or whole note

        if (!textToSummarize || textToSummarize.trim().length < 20) {
            return coreAPI.showGlobalStatus("Not enough text selected/available to summarize.", "info");
        }

        coreAPI.showGlobalStatus("Summarizing with AI...", "info");
        try {
            const summary = await llmService.summarizeText(textToSummarize);
            if (summary) {
                // Insert summary below current content or replace selection? Let's insert below.
                const currentContent = editorService.getContent();
                const summaryBlock = `\n\n---\n**AI Summary:**\n${summary}\n---`;
                // If text was selected, maybe replace it instead? For now, always append.
                // editorService.setContent(currentContent + summaryBlock); // Append
                editorService.insertContentAtCursor(summaryBlock); // Insert at cursor
                coreAPI.showGlobalStatus("Summary generated.", "success", 3000);
            } else {
                // Error/null handled within summarizeText
            }
        } catch (e) {
            console.error("Summarize action failed:", e);
            // Error shown by LLMService
        }
    }

    async _handleLlmAskQuestion(noteId) {
        const coreAPI = window.realityNotebookCore;
        const editorService = coreAPI?.getService('EditorService');
        const llmService = coreAPI?.getService('LLMService');
        if (!editorService || !llmService) return coreAPI?.showGlobalStatus("LLM/Editor service not ready.", "warning");

        const question = prompt("Ask a question about the note content:");
        if (!question || question.trim().length < 3) return;

        const contextText = editorService.getContent();
        if (!contextText || contextText.trim().length < 10) {
            return coreAPI.showGlobalStatus("Note content is too short.", "info");
        }

        coreAPI.showGlobalStatus("Asking AI...", "info");
        try {
            const answer = await llmService.answerQuestion(contextText, question);
            if (answer) {
                // Insert answer into the editor
                const answerBlock = `\n\n---\n**Q:** ${question}\n**A:** ${answer}\n---`;
                editorService.insertContentAtCursor(answerBlock);
                coreAPI.showGlobalStatus("Answer inserted into note.", "success", 3000);
            } else {
                // Error/null handled within answerQuestion, status message shown there
            }
        } catch (e) {
            console.error("Ask Question action failed:", e);
            // Error shown by LLMService
        }
    }

    async _handleLlmGetActions(noteId) {
        const coreAPI = window.realityNotebookCore;
        const editorService = coreAPI?.getService('EditorService');
        const llmService = coreAPI?.getService('LLMService');
        if (!editorService || !llmService) return coreAPI?.showGlobalStatus("LLM/Editor service not ready.", "warning");

        const textForActions = editorService.getContent();
        if (!textForActions || textForActions.trim().length < 10) {
            return coreAPI.showGlobalStatus("Note content is too short to suggest actions.", "info");
        }

        coreAPI.showGlobalStatus("Suggesting actions with AI...", "info");
        try {
            const actions = await llmService.getActions(textForActions);
            if (actions === null) {
                // Error handled within getActions, status message shown there
            } else if (actions.length > 0) {
                // Insert actions as a list into the editor
                const actionsList = actions.map(a => `<li>${a}</li>`).join('');
                const actionsBlock = `\n\n---\n**Suggested Actions:**\n<ul>${actionsList}</ul>\n---`;
                editorService.insertContentAtCursor(actionsBlock);
                coreAPI.showGlobalStatus("Suggested actions inserted into note.", "success", 3000);
            } else {
                coreAPI.showGlobalStatus("No specific actions suggested by AI.", "info", 3000); // Keep info message
            }
        } catch (e) {
            console.error("Get Actions action failed:", e);
            // Error shown by LLMService
        }
    }

    // --- End LLM Action Handlers ---

    // --- UI Event Handlers (Bound using arrow functions) ---
    _handleOpenSettings = () => this._stateManager.dispatch({type: 'CORE_OPEN_MODAL', payload: {modalId: 'settings'}});
    _handleCloseModal = () => this._stateManager.dispatch({type: 'CORE_CLOSE_MODAL'});
    _handleAddNote = () => this._stateManager.dispatch({type: 'CORE_ADD_NOTE'});
    _handleSelectNote = (noteId) => this._stateManager.dispatch({type: 'CORE_SELECT_NOTE', payload: {noteId}});
    _handleArchiveNote = (noteId) => () => this._stateManager.dispatch({type: 'CORE_ARCHIVE_NOTE', payload: {noteId}}); // Wrap if needed for direct use
    _handleDeleteNote = (noteId, noteName) => () => { // Wrap if needed for direct use
        if (confirm(`Are you sure you want to permanently delete "${noteName || 'Untitled Note'}"?`)) {
            this._stateManager.dispatch({type: 'CORE_DELETE_NOTE', payload: {noteId}});
        }
    };
    _handleCoreSettingChange = (e) => {
        const key = e.target.dataset.settingKey;
        const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value; // Handle checkbox
        if (key) {
            this._stateManager.dispatch({type: 'CORE_SET_CORE_SETTING', payload: {key, value}});
        }
    };
    _handleSearchInput = (e) => this._stateManager.dispatch({
        type: 'CORE_SEARCH_TERM_CHANGED',
        payload: {searchTerm: e.target.value}
    });
    _handleSortChange = (e) => this._stateManager.dispatch({
        type: 'CORE_SET_NOTE_LIST_SORT_MODE',
        payload: e.target.value
    });
    _handleTitleInput = (noteId) => (e) => { // Debounced update for title
        const newValue = e.target.value;
        // Use a debounced function if desired, or dispatch directly
        // For simplicity, dispatching directly here. Consider debouncing if performance is an issue.
        this._stateManager.dispatch({type: 'CORE_UPDATE_NOTE', payload: {noteId, changes: {name: newValue}}});
    };
    _handleContentInput = (noteId) => (e) => { // Debounced update for core textarea content
        const newValue = e.target.value;
        // This handler is only for the *core* textarea, not Tiptap.
        // Debouncing is recommended here.
        // Example (assuming a debounce utility is available):
        // this._debouncedContentUpdate(noteId, newValue);
        // Direct dispatch for simplicity:
        this._stateManager.dispatch({type: 'CORE_UPDATE_NOTE', payload: {noteId, changes: {content: newValue}}});
    };
    _handleNoteListKeyDown = (e) => {
        // Basic keyboard navigation for note list (example)
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const currentItem = e.target.closest('.note-list-item');
            const nextItem = e.key === 'ArrowDown' ? currentItem?.nextElementSibling : currentItem?.previousElementSibling;
            if (nextItem && nextItem.matches('.note-list-item')) {
                nextItem.focus();
                // Optionally select on navigation:
                // const noteId = nextItem.dataset.noteId;
                // if (noteId) this._handleSelectNote(noteId);
            }
        } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            const currentItem = e.target.closest('.note-list-item');
            const noteId = currentItem?.dataset.noteId;
            if (noteId) this._handleSelectNote(noteId);
        }
    };
    _handleClearState = () => {
        if (confirm(`WARNING: This will delete ALL your notes and settings locally and cannot be undone. Are you absolutely sure?`)) {
            if (confirm(`SECOND WARNING: Please confirm again that you want to erase everything.`)) {
                window._clearState(); // Call the debug function exposed globally
            }
        }
    };

    // --- Search Query Parsing Helper ---
    _parseSearchQuery(query) {
        const structuredFilters = [];
        // Regex to find key:value pairs, potentially with operators like >, <, !=
        // Example: key:value key:"quoted value" key>10 key!=false
        const filterRegex = /(\w+)\s*(!?[:><]=?)\s*("([^"]*)"|'([^']*)'|(\S+))/g;
        let textQuery = query;
        let match;

        while ((match = filterRegex.exec(query)) !== null) {
            const key = match[1];
            const operator = match[2];
            // Value can be quoted or unquoted
            const value = match[4] ?? match[5] ?? match[6];

            structuredFilters.push({key: key.toLowerCase(), operator, value});

            // Remove the matched filter from the text query part
            textQuery = textQuery.replace(match[0], '').trim();
        }

        return {textQuery: textQuery.trim(), structuredFilters};
    }

    // --- Structured Filter Evaluation Helper ---
    _evaluateStructuredFilters(noteProperties, structuredFilters) {
        const ontologyService = this._getOntologyService(); // Use lazy getter

        for (const filter of structuredFilters) {
            const prop = noteProperties.find(p => p.key.toLowerCase() === filter.key);

            // If filtering on a key the note doesn't have, it's not a match (unless operator is !=)
            if (!prop && filter.operator !== '!=') {
                return false;
            }
            // Handle != operator specifically for non-existent keys
            if (!prop && filter.operator === '!=') {
                continue; // Property doesn't exist, so it's "not equal" to the filter value
            }

            // Property exists, now compare values
            const propValue = prop.value;
            const filterValueStr = filter.value;
            const propType = prop.type || ontologyService?.inferType(propValue, filter.key) || 'text';

            let match = false;

            // --- Comparison Logic (Needs refinement for dates, numbers, booleans) ---
            try {
                // Basic type coercion/comparison
                if (propType === 'number') {
                    const numProp = Number(propValue);
                    const numFilter = Number(filterValueStr);
                    if (!isNaN(numProp) && !isNaN(numFilter)) {
                        switch (filter.operator) {
                            case ':':
                            case '=':
                                match = numProp === numFilter;
                                break;
                            case '>':
                                match = numProp > numFilter;
                                break;
                            case '>=':
                                match = numProp >= numFilter;
                                break;
                            case '<':
                                match = numProp < numFilter;
                                break;
                            case '<=':
                                match = numProp <= numFilter;
                                break;
                            case '!=':
                                match = numProp !== numFilter;
                                break;
                            default:
                                match = false; // Unsupported operator for type
                        }
                    }
                } else if (propType === 'boolean') {
                    const boolProp = String(propValue).toLowerCase() === 'true' || propValue === true;
                    const boolFilter = String(filterValueStr).toLowerCase() === 'true' || filterValueStr === true;
                    switch (filter.operator) {
                        case ':':
                        case '=':
                            match = boolProp === boolFilter;
                            break;
                        case '!=':
                            match = boolProp !== boolFilter;
                            break;
                        default:
                            match = false;
                    }
                } else if (propType === 'date') {
                    // TODO: Implement robust date comparison (e.g., using a library)
                    // Handle relative dates ('today', 'next-week', 'yesterday') and operators
                    // Placeholder: simple string comparison for now
                    const dateProp = new Date(propValue);
                    const dateFilter = new Date(filterValueStr); // Very basic parsing
                    if (!isNaN(dateProp) && !isNaN(dateFilter)) {
                        switch (filter.operator) {
                            case ':':
                            case '=':
                                match = dateProp.toDateString() === dateFilter.toDateString();
                                break; // Compare day only
                            case '>':
                                match = dateProp > dateFilter;
                                break;
                            case '>=':
                                match = dateProp >= dateFilter;
                                break;
                            case '<':
                                match = dateProp < dateFilter;
                                break;
                            case '<=':
                                match = dateProp <= dateFilter;
                                break;
                            case '!=':
                                match = dateProp.toDateString() !== dateFilter.toDateString();
                                break;
                            default:
                                match = false;
                        }
                    } else { // Fallback to string compare if dates invalid
                        match = String(propValue).toLowerCase().includes(filterValueStr.toLowerCase());
                    }
                } else if (propType === 'list') {
                    const listProp = Array.isArray(propValue) ? propValue : String(propValue).split(',').map(s => s.trim());
                    const lowerFilter = filterValueStr.toLowerCase();
                    match = listProp.some(item => String(item).toLowerCase().includes(lowerFilter));
                    if (filter.operator === '!=') match = !match;
                    else if (filter.operator !== ':' && filter.operator !== '=') match = false; // Only equality/contains for lists now
                } else { // Default: text comparison (case-insensitive contains)
                    const textProp = String(propValue).toLowerCase();
                    const textFilter = filterValueStr.toLowerCase();
                    match = textProp.includes(textFilter);
                    if (filter.operator === '!=') match = !match;
                    else if (filter.operator !== ':' && filter.operator !== '=') match = false; // Only equality/contains for text now
                }
            } catch (e) {
                console.warn(`Error comparing property '${filter.key}' (type: ${propType})`, e);
                match = false;
            }
            // --- End Comparison Logic ---

            // If any filter doesn't match, the whole set fails
            if (!match) return false;
        }

        // All filters passed
        return true;
    }


    // --- Centralized Modal Rendering Logic ---
    _renderModal(state) {
        // Get modalType and modalProps from the NEW state structure
        const {modalType, modalProps} = state.uiState;
        if (!modalType) return '';

        switch (modalType) {
            case 'settings':
                return this._renderSettingsModal(state);
            case 'templateSelector':
                return this._renderTemplateSelectorModal(state, modalProps);
            case 'propertyAdd':
                return this._renderPropertyAddModal(state, modalProps);
            case 'propertyEdit':
                return this._renderPropertyEditModal(state, modalProps);
            // Add other modal types here
            default:
                console.warn(`UIRenderer: Unknown modal type requested: ${modalType}`);
                return '';
        }
    }

    // --- Specific Modal Renderers ---

    _renderTemplateSelectorModal(state, props) {
        const {templates = [], context = 'insert', onSelectActionType = 'TEMPLATE_SELECTED'} = props; // Expect templates array and context

        const handleSelect = (template) => {
            this._stateManager.dispatch({type: onSelectActionType, payload: {template, context}});
            this._handleCloseModal(); // Close modal after selection
        };

        return html`
            <div id="modal-backdrop" class="modal-backdrop" @click=${this._handleCloseModal}></div>
            <div class="modal-content template-selector-modal" role="dialog" aria-modal="true" aria-labelledby="template-selector-title">
                <button class="modal-close-button" @click=${this._handleCloseModal} aria-label="Close">×</button>
                <h2 id="template-selector-title">Select Template to ${context}</h2>
                ${templates.length === 0 ? html`<p>No templates available.</p>` : ''}
                <ul class="modal-list">
                    ${templates.map(template => html`
                        <li class="modal-list-item">
                            <button @click=${() => handleSelect(template)} title=${template.description || ''}>${template.name}</button>
                        </li>
                    `)}
                </ul>
                <style>
                    .template-selector-modal .modal-list-item button { width: 100%; text-align: left; padding: 8px 12px; }
                </style>
            </div>
        `;
    }

    _renderPropertyAddModal(state, props) {
        const {noteId, possibleKeys = [], onAddActionType = 'PROPERTY_ADD_CONFIRMED'} = props;
        const coreAPI = window.realityNotebookCore; // Get core API instance
        const ontologyService = coreAPI?.getService('OntologyService');

        const handleSubmit = (event) => {
            event.preventDefault();
            const form = event.target;
            const key = form.keySelect.value === '__custom__' ? form.customKey.value.trim() : form.keySelect.value;
            const value = form.value.value;
            const temporaryId = `temp_${Utils.generateUUID()}`; // Generate temporary ID for potential error association

            if (key) {
                // Dispatch the action, the reducer will handle validation
                this._stateManager.dispatch({
                    type: onAddActionType,
                    payload: { noteId, key, value, temporaryId } // Pass temporaryId
                });
                // Don't close modal immediately, wait for state update to see if validation passed
                // If validation passes, the error state for this tempId won't be set.
                // If it fails, the error state *will* be set, and the modal should stay open showing the error.
                // We need a way to check if the add was successful *after* dispatch. This is tricky.
                // Option A: Close optimistically, rely on global status for error. (Simpler)
                // Option B: Keep modal open, check error state on next render. (Better UX)

                // Let's try Option B: Keep modal open, check error state in render.
                // The modal will re-render with the error message if validation fails.
                // If validation succeeds, the property will be added, and the modal *should* close.
                // How to trigger close on success? Maybe the reducer clears the error *and* closes the modal? No, reducers shouldn't cause side effects.
                // Maybe the component checks: if no error exists for tempId after dispatch, *then* close?

                // Let's stick to the original plan: Dispatch, let reducer handle validation failure state.
                // The modal render logic will show the error if it exists in the state.
                // We need to manually close only if the dispatch *didn't* result in an error state for this tempId.
                // This requires checking state *after* dispatch, which is awkward here.

                // --- Revised Approach ---
                // Dispatch the add action.
                // The reducer will either add the property OR set a validation error in uiState.
                // The modal's render function will check for the validation error associated with `temporaryId`.
                // If an error is displayed, the user can correct and resubmit.
                // If the property *is* successfully added (no error state set), how does the modal close?
                // We can check in the render function: if the property now exists and there's no error, close? Seems complex.

                // --- Simplest Approach (Compromise) ---
                // Dispatch the add action. If validation fails *synchronously* within the reducer (which it does now),
                // the error state will be set *before* this function continues. We can check it immediately after dispatch.
                // This relies on synchronous reducer execution.
                this._stateManager.dispatch({
                    type: onAddActionType,
                    payload: { noteId, key, value, temporaryId }
                });

                // Check state *immediately* after dispatch (assuming sync reducer)
                const potentialError = this._stateManager.getState().uiState.propertyValidationErrors?.[noteId]?.[temporaryId];
                if (!potentialError) {
                    this._handleCloseModal(); // Close only if validation likely passed (no error set)
                }
                // If potentialError exists, the modal stays open, and the error will be rendered.

            } else {
                coreAPI?.showGlobalStatus("Property key cannot be empty.", "warning");
            }
        };

        const handleKeyChange = (event) => {
            const customKeyInput = event.target.form.customKey;
            customKeyInput.style.display = event.target.value === '__custom__' ? 'block' : 'none';
            if (event.target.value !== '__custom__') {
                customKeyInput.value = ''; // Clear custom if selection changes
            }
        };

        return html`
            <div id="modal-backdrop" class="modal-backdrop" @click=${this._handleCloseModal}></div>
            <div class="modal-content property-add-modal" role="dialog" aria-modal="true" aria-labelledby="property-add-title">
                <button class="modal-close-button" @click=${this._handleCloseModal} aria-label="Close">×</button>
                <h2 id="property-add-title">Add Property</h2>
                <form @submit=${handleSubmit}>
                    <div class="form-field">
                        <label for="prop-key-select">Property Key:</label>
                        <select id="prop-key-select" name="keySelect" @change=${handleKeyChange} required>
                            <option value="" disabled selected>-- Select or Add --</option>
                            ${possibleKeys.map(k => {
            const hints = ontologyService?.getUIHints(k) || {icon: '?'};
            return html`<option value="${k}">${hints.icon} ${k}</option>`;
        })}
                            <option value="__custom__">-- Add Custom Key --</option>
                        </select>
                        <input type="text" name="customKey" placeholder="Enter custom key name" style="display: none; margin-top: 5px;">
                    </div>
                    <div class="form-field">
                        <label for="prop-value-input">Value:</label>
                        <input type="text" id="prop-value-input" name="value" required aria-describedby="prop-add-error">
                        <div id="prop-add-error" class="validation-error">
                            ${state.uiState.propertyValidationErrors?.[noteId]?.[`temp_${props.temporaryId}`] || ''}
                        </div>
                    </div>
                    <div class="modal-actions">
                        <button type="button" @click=${this._handleCloseModal}>Cancel</button>
                        <button type="submit">Add Property</button>
                    </div>
                </form>
            </div>
        `;
    }

    _renderPropertyEditModal(state, props) {
        const {
            noteId,
            property,
            onUpdateActionType = 'PROPERTY_UPDATE_CONFIRMED',
            onDeleteActionType = 'PROPERTY_DELETE_CONFIRMED'
        } = props;
        if (!property) return ''; // Should not happen
        const coreAPI = window.realityNotebookCore;
        const ontologyService = coreAPI?.getService('OntologyService');
        const hints = ontologyService?.getUIHints(property.key) || {};
        const inputType = hints.inputType || 'text';

        // Function to render the correct input based on type hint
        const renderInput = () => {
            // Reuse logic from InlinePropertyNodeView or PropertiesPlugin UI
            // For simplicity, using text input for now, but should be enhanced
            // based on inputType (date, select, checkbox, range etc.)
            if (inputType === 'select' && hints.options) {
                return html`<select name="value" required>
                    ${hints.options.map(opt => html`
                        <option value="${opt}" ?selected=${opt === property.value}>${opt}</option>
                    `)}
                </select>`;
            } else if (inputType === 'checkbox') { // Boolean
                return html`<input type="checkbox" name="value" .checked=${!!property.value}>`;
            } else if (inputType === 'date') {
                const dateValue = property.value ? new Date(property.value).toISOString().split('T')[0] : '';
                return html`<input type="date" name="value" .value=${dateValue}>`;
            } else if (inputType === 'number') {
                return html`<input type="number" name="value" .value=${property.value ?? ''} step=${hints.step ?? 'any'}>`;
            } else { // Default text
                return html`<input type="text" name="value" .value=${property.value ?? ''} required>`;
            }
        };

        const handleUpdate = (event) => {
            event.preventDefault();
            const form = event.target;
            const newKey = form.key.value.trim();
            const newValueRaw = inputType === 'checkbox' ? form.value.checked : form.value.value; // Get value from checkbox or other input
            // Normalize value based on original type before dispatching
            const newValueNormalized = coreAPI.getPluginAPI('properties')?._normalizeValue(newValueRaw, property.type) ?? newValueRaw;

            if (newKey) {
                const changes = {};
                if (newKey !== property.key) changes.key = newKey;
                if (newValueNormalized !== property.value) changes.value = newValueNormalized;
                // TODO: Add type change possibility?

                if (Object.keys(changes).length > 0) {
                     // Dispatch update action
                    this._stateManager.dispatch({
                        type: onUpdateActionType,
                        payload: {noteId, propertyId: property.id, changes}
                    });

                    // Check state *immediately* after dispatch for validation errors
                    const potentialError = this._stateManager.getState().uiState.propertyValidationErrors?.[noteId]?.[property.id];
                    if (!potentialError) {
                        this._handleCloseModal(); // Close only if validation likely passed
                    }
                    // If potentialError exists, modal stays open, error is rendered.
                } else {
                    this._handleCloseModal(); // No changes, just close
                }
            } else {
                coreAPI?.showGlobalStatus("Property key cannot be empty.", "warning");
            }
        };

        const handleDelete = () => {
            if (confirm(`Are you sure you want to delete property "${property.key}"?`)) {
                this._stateManager.dispatch({type: onDeleteActionType, payload: {noteId, propertyId: property.id}});
                this._handleCloseModal();
            }
        };

        return html`
            <div id="modal-backdrop" class="modal-backdrop" @click=${this._handleCloseModal}></div>
            <div class="modal-content property-edit-modal" role="dialog" aria-modal="true" aria-labelledby="property-edit-title">
                <button class="modal-close-button" @click=${this._handleCloseModal} aria-label="Close">×</button>
                <h2 id="property-edit-title">Edit Property: ${hints.icon || ''} ${property.key}</h2>
                <form @submit=${handleUpdate}>
                    <div class="form-field">
                        <label for="prop-edit-key">Key:</label>
                        <input type="text" id="prop-edit-key" name="key" .value=${property.key} required>
                    </div>
                    <div class="form-field">
                        <label for="prop-edit-value">Value (Type: ${property.type}):</label>
                        ${renderInput()}
                         <div id="prop-edit-error-${property.id}" class="validation-error">
                            ${state.uiState.propertyValidationErrors?.[noteId]?.[property.id] || ''}
                        </div>
                    </div>
                    <!-- TODO: Add Type selector? -->
                    <div class="modal-actions">
                        <button type="button" class="danger" @click=${handleDelete}>Delete</button>
                        <button type="button" @click=${this._handleCloseModal}>Cancel</button>
                        <button type="submit">Update Property</button>
                    </div>
                </form>
            </div>
        `;
    }


    // --- Method for plugins to register components ---
    registerSlotComponent(pluginId, slotName, renderFn) {
        if (!this._slotRegistry.has(slotName)) {
            this._slotRegistry.set(slotName, []);
        }
        // Prevent duplicate registration? Or allow multiple? Allow for now.
        this._slotRegistry.get(slotName).push({pluginId, renderFn});
        console.log(`UIRenderer: Registered component from [${pluginId}] for slot [${slotName}]`);
        // Trigger a re-render after registration? Debounced?
        this._scheduleRender(); // Schedule a render to show the new component
    }

    // --- Scroll position saving/restoring ---
    _saveScrollPositions() {
        // Save scroll position for elements likely to need it
        const noteList = this._rootElement?.querySelector('#note-list');
        if (noteList) this._scrollPositions.noteList = noteList.scrollTop;
        const editorArea = this._rootElement?.querySelector('#editor-area');
        if (editorArea) this._scrollPositions.editorArea = editorArea.scrollTop;
        // console.log("Saving scroll:", this._scrollPositions);
    }

    _restoreScrollPositions() {
        // Use requestAnimationFrame to ensure DOM is settled before restoring
        requestAnimationFrame(() => {
            // console.log("Attempting restore scroll:", this._scrollPositions);
            const noteList = this._rootElement?.querySelector('#note-list');
            if (noteList && this._scrollPositions.hasOwnProperty('noteList')) {
                noteList.scrollTop = this._scrollPositions.noteList;
            }
            const editorArea = this._rootElement?.querySelector('#editor-area');
            if (editorArea && this._scrollPositions.hasOwnProperty('editorArea')) {
                editorArea.scrollTop = this._scrollPositions.editorArea;
            }
            // Clear saved positions after restoring
            this._scrollPositions = {};
        });
    }
}

class PluginManager {
    _pluginRegistry = new Map();
    _pluginLoadOrder = [];
    _coreAPI = null;
    _stateManager = null;
    _uiRenderer = null;
    _eventBus = null;
    _services = new Map();

    constructor(stateManager, uiRenderer, eventBus) {
        this._stateManager = stateManager;
        this._uiRenderer = uiRenderer;
        this._eventBus = eventBus;
        this._coreAPI = new CoreAPI(stateManager, this, uiRenderer, eventBus); // Pass 'this' for getService/getPluginAPI
        console.log("PluginManager initialized.");
    }

    registerPlugins(pluginDefinitions) {
        pluginDefinitions.forEach(x => this.registerPlugin(x));
    }

    registerPlugin(pluginDefinition) {
        const {id, name, version, dependencies = [], init} = pluginDefinition;
        if (!id || !name || typeof init !== 'function') {
            console.error(`Plugin registration failed: Missing required fields (id, name, init function) for ${id || name || 'unknown plugin'}.`);
            return;
        }
        if (this._pluginRegistry.has(id)) {
            console.warn(`Plugin: Plugin [${id}] definition already registered. Skipping.`);
            return;
        }

        const entry = {
            definition: pluginDefinition,
            instance: null, // Will be the definition object itself
            status: 'registered',
            error: null,
            api: null
        };
        this._pluginRegistry.set(id, entry);
        console.log(`Plugin: [${id}] v${version || 'N/A'} registered`);
    }


    activatePlugins() {
        try {
            this._pluginLoadOrder = Utils.dependencySort(this._pluginRegistry);
            console.log("Plugin: load order:", this._pluginLoadOrder);
        } catch (e) {
            console.error("Plugin: Stopped activation due to dependency errors.", e);
            this._eventBus.publish('PLUGIN_ACTIVATION_FAILED', {error: e.message});
            // Optionally show a global error status
            this._coreAPI.showGlobalStatus(`Plugin activation failed: ${e.message}`, 'error', 0);
            return; // Stop activation
        }

        //console.log('Plugin: Activating plugins...');
        this._pluginLoadOrder.forEach(pluginId => {
            const entry = this._pluginRegistry.get(pluginId);
            if (!entry || entry.status !== 'registered') return; // Should not happen if load order is correct

            // Double-check dependencies are active (belt-and-suspenders)
            const deps = entry.definition.dependencies || [];
            const depsMet = deps.every(depId => this._pluginRegistry.get(depId)?.status === 'active');
            if (!depsMet) {
                entry.status = 'error';
                entry.error = new Error(`Dependency not met during activation phase (should not happen).`);
                console.error(`Plugin: Activation Error - Dependency check failed just before activating [${pluginId}].`);
                this._eventBus.publish('PLUGIN_STATUS_CHANGED', {
                    pluginId,
                    status: 'error',
                    error: entry.error.message
                });
                return;
            }

            entry.status = 'activating';
            console.log(`Plugin: [${pluginId}] activating`);

            try {
                // Treat definition object as instance for simplicity
                entry.instance = entry.definition;

                // --- Execute Plugin Lifecycle Methods ---
                // 1. init (CoreAPI ready)
                entry.instance.init(this._coreAPI);

                // 2. registerReducer
                if (typeof entry.instance.registerReducer === 'function') {
                    const reducer = entry.instance.registerReducer();
                    if (reducer) this._stateManager.registerReducer(pluginId, reducer);
                }

                // 3. registerMiddleware
                if (typeof entry.instance.registerMiddleware === 'function') {
                    const middleware = entry.instance.registerMiddleware();
                    if (middleware) this._stateManager.registerMiddleware(pluginId, middleware);
                }

                // 4. registerUISlots
                if (typeof entry.instance.registerUISlots === 'function') {
                    const slots = entry.instance.registerUISlots() || {};
                    Object.entries(slots).forEach(([slotName, renderFn]) => {
                        if (typeof renderFn === 'function') {
                            this._uiRenderer.registerSlotComponent(pluginId, slotName, renderFn);
                        } else {
                            console.warn(`Plugin: Invalid render function for slot [${slotName}] from [${pluginId}]`);
                        }
                    });
                }

                // 5. providesServices
                if (typeof entry.instance.providesServices === 'function') {
                    const services = entry.instance.providesServices() || {};
                    Object.entries(services).forEach(([serviceName, serviceInstance]) => {
                        this.registerService(pluginId, serviceName, serviceInstance);
                    });
                }

                // 6. getAPI
                if (typeof entry.instance.getAPI === 'function')
                    entry.api = entry.instance.getAPI();


                // 7. onActivate
                if (typeof entry.instance.onActivate === 'function')
                    entry.instance.onActivate();

                entry.status = 'active';
                console.log(`Plugin: [${pluginId}] activated`);
                this._eventBus.publish('PLUGIN_STATUS_CHANGED', {pluginId, status: 'active'});

            } catch (error) {
                console.error(`Plugin: [${pluginId}] failed during activation`, error);
                entry.status = 'error';
                entry.error = error;
                this._eventBus.publish('PLUGIN_STATUS_CHANGED', {pluginId, status: 'error', error: error.message});
            }
        });

        // After attempting all activations:
        const failedPlugins = Array.from(this._pluginRegistry.values()).filter(p => p.status === 'error');
        if (failedPlugins.length > 0) {
            console.error("Plugin: Failed to activate:", failedPlugins.map(p => p.definition.id));
            this._coreAPI.showGlobalStatus(`${failedPlugins.length} plugin(s) failed to activate. Check console.`, 'error', 10000);
        } else if (this._pluginLoadOrder.length > 0)
            console.log("Plugin: All plugins activated.");
        else
            console.log("Plugin: No plugins registered or activated.");

    }

    registerService(pluginId, serviceName, serviceInstance) {
        if (!serviceInstance || typeof serviceInstance !== 'object') {
            console.error(`Plugin: Invalid service instance provided for [${serviceName}] by plugin [${pluginId}].`);
            return;
        }
        if (this._services.has(serviceName)) {
            const existingProvider = this._services.get(serviceName).providerPluginId;
            console.warn(`Plugin: Service [${serviceName}] already registered by [${existingProvider}]. Overwriting by [${pluginId}].`);
        }
        this._services.set(serviceName, {instance: serviceInstance, providerPluginId: pluginId});
        console.log(`Plugin: service [${serviceName}] registered from plugin [${pluginId}]`);
    }

    getService(serviceName) {
        const entry = this._services.get(serviceName);
        return entry ? entry.instance : null;
    }

    getPluginAPI(pluginId) {
        const entry = this._pluginRegistry.get(pluginId);
        if (!entry || entry.status !== 'active') {
            console.warn(`Plugin: API requested for inactive or non-existent plugin [${pluginId}] (Status: ${entry?.status || 'N/A'})`);
            return null;
        }
        return entry.api;
    }
}

class CoreAPI {
    _stateManager = null;
    _pluginManager = null;
    _uiRenderer = null;
    _eventBus = null;
    utils = Utils;

    constructor(stateManager, pluginManager, uiRenderer, eventBus) {
        this._stateManager = stateManager;
        this._pluginManager = pluginManager;
        this._uiRenderer = uiRenderer;
        this._eventBus = eventBus;
        // Freeze the API object to prevent plugins from modifying it accidentally
        Object.freeze(this);
        Object.freeze(this.utils);
    }

    // --- State ---
    dispatch = (action) => this._stateManager.dispatch(action);
    getState = () => this._stateManager.getState();
    subscribe = (listener) => this._stateManager.subscribe(listener);

    // --- State Helpers ---
    getNoteById = (noteId) => this.getState().notes[noteId] || null;
    getSelectedNote = () => {
        const state = this.getState();
        return state.uiState.selectedNoteId ? state.notes[state.uiState.selectedNoteId] : null;
    };
    getSystemNoteByType = (systemType) => {
        const state = this.getState();
        const noteId = state.systemNoteIndex[systemType];
        return noteId ? state.notes[noteId] : null;
    };
    getPluginSettings = (pluginId) => this.getState().settings.plugins[pluginId] || {};
    getRuntimeCache = (key) => this.getState().runtimeCache[key];

    // --- Events ---
    publishEvent = (eventType, payload) => this._eventBus.publish(eventType, payload);
    subscribeToEvent = (eventType, handler) => this._eventBus.subscribe(eventType, handler);

    // --- UI ---
    // Plugins register slots via definition, not API.
    // Ephemeral components might be better handled via dedicated state/actions.
    showGlobalStatus = (message, type = 'info', duration = 5000, id = null) => {
        // Dispatch action to update state
        this.dispatch({type: 'CORE_SET_GLOBAL_STATUS', payload: {message, type, duration, id}});
        // Schedule clearing via timeout -> dispatching another action
        // This avoids side effects directly in the API method or reducer.
        if (duration > 0 && duration !== Infinity) {
            setTimeout(() => {
                // Check if the message is still the same before clearing
                const currentState = this.getState();
                const currentStatus = id ? currentState.uiState.globalStatusMessages?.[id] : currentState.uiState.globalStatus; // Check specific or general
                if (currentStatus?.message === message && currentStatus?.type === type) {
                    this.dispatch({type: 'CORE_CLEAR_GLOBAL_STATUS', payload: {id}}); // Pass ID to clear specific message
                }
            }, duration);
        }
    };

    clearGlobalStatus = (id = null) => {
        this.dispatch({type: 'CORE_CLEAR_GLOBAL_STATUS', payload: {id}});
    };

    // --- Services & Plugins ---
    getService = (serviceName) => this._pluginManager.getService(serviceName);
    getPluginAPI = (pluginId) => this._pluginManager.getPluginAPI(pluginId);
}

// --- 8. Core Data Model & Initial State ---
const initialAppState = {
    notes: {}, // { [id]: CoreNote }
    noteOrder: [], // [id1, id2, ...]
    systemNoteIndex: {}, // { [systemType]: noteId }
    settings: {
        core: {theme: 'light', userId: null, onboardingComplete: false},
        // plugins: {}
    },
    uiState: {
        selectedNoteId: null,
        searchTerm: '',
        noteListSortMode: 'time',
        activeModal: null, // Keep for compatibility? No, remove.
        modalType: null, // e.g., 'settings', 'propertyEdit'
        modalProps: null, // Props for the current modal
        globalStatus: null, // { message, type, duration, id? } - For single status message
        globalStatusMessages: {}, // { [id]: { message, type, duration } } - For multiple persistent messages
        propertyValidationErrors: {}, // { [noteId]: { [propertyId]: errorMessage } } - Transient validation errors
        // noteListSortMode: 'time', // Default sort mode <-- Removed duplicate
    },
    pluginRuntimeState: {}, // State managed *by* plugins, persisted if needed by plugin reducer
    runtimeCache: {}, // Non-persistent cache for runtime data
};

const coreReducer = (draft, action) => {
    switch (action.type) {
        case 'CORE_STATE_LOADED': {
            const loaded = action.payload.loadedState || {};
            Object.assign(draft, initialAppState);
            draft.notes = loaded.notes || {};
            draft.noteOrder = Array.isArray(loaded.noteOrder) ? loaded.noteOrder.filter(id => draft.notes[id]) : [];
            draft.settings.core = {...initialAppState.settings.core, ...(loaded.settings?.core || {})};
            draft.runtimeCache = loaded.runtimeCache || {};
            draft.systemNoteIndex = {};
            Object.values(draft.notes).forEach(note => {
                if (note.systemType)
                    draft.systemNoteIndex[note.systemType] = note.id;
            });
            break;
        }

        case 'CORE_ADD_NOTE': {
            const newNoteId = Utils.generateUUID();
            const now = Date.now();
            const systemType = action.payload?.systemType || null;
            draft.notes[newNoteId] = {
                id: newNoteId,
                name: action.payload?.name || 'New Note',
                content: action.payload?.content || '',
                createdAt: now,
                updatedAt: now,
                isArchived: false,
                systemType: systemType,
                // pluginData is NOT initialized here
            };
            draft.noteOrder.unshift(newNoteId); // Add to beginning
            draft.uiState.selectedNoteId = newNoteId;
            draft.uiState.searchTerm = ''; // Clear search on add
            if (systemType) {
                if (draft.systemNoteIndex[systemType]) console.warn(`CORE_ADD_NOTE: Overwriting system index for type ${systemType}`);
                draft.systemNoteIndex[systemType] = newNoteId;
            }
            break;
        }

        case 'CORE_SELECT_NOTE': {
            const {noteId} = action.payload;
            if (draft.notes[noteId] && draft.uiState.selectedNoteId !== noteId) {
                draft.uiState.selectedNoteId = noteId;
            }
            break;
        }

        case 'CORE_UPDATE_NOTE': {
            const {noteId, changes} = action.payload;
            const note = draft.notes[noteId];
            if (!note) break; // Note doesn't exist

            let coreFieldsChanged = false;
            const oldSystemType = note.systemType;
            let newSystemType = oldSystemType;

            // Update core fields directly on the draft
            if (changes.hasOwnProperty('name') && note.name !== changes.name) {
                note.name = changes.name;
                coreFieldsChanged = true;
            }
            if (changes.hasOwnProperty('content') && note.content !== changes.content) {
                note.content = changes.content;
                coreFieldsChanged = true;
            }
            if (changes.hasOwnProperty('isArchived') && note.isArchived !== changes.isArchived) {
                note.isArchived = changes.isArchived;
                coreFieldsChanged = true;
            }
            if (changes.hasOwnProperty('systemType') && note.systemType !== changes.systemType) {
                note.systemType = changes.systemType;
                newSystemType = changes.systemType;
                coreFieldsChanged = true;
            }

            if (coreFieldsChanged) {
                note.updatedAt = Date.now(); // Update timestamp if core fields changed

                // Update systemNoteIndex if systemType changed
                if (newSystemType !== oldSystemType) {
                    if (oldSystemType && draft.systemNoteIndex[oldSystemType] === noteId) {
                        delete draft.systemNoteIndex[oldSystemType];
                    }
                    if (newSystemType) {
                        if (draft.systemNoteIndex[newSystemType]) console.warn(`CORE_UPDATE_NOTE: Overwriting system index for type ${newSystemType}`);
                        draft.systemNoteIndex[newSystemType] = noteId;
                    }
                }
                // If archiving, deselect the note
                if (changes.isArchived === true && draft.uiState.selectedNoteId === noteId) {
                    draft.uiState.selectedNoteId = null;
                }
            }
            // Plugin reducers will handle changes to pluginData for this note
            break;
        }

        case 'CORE_ARCHIVE_NOTE': {
            // Delegate to CORE_UPDATE_NOTE logic within the same reducer pass
            const note = draft.notes[action.payload.noteId];
            if (note && !note.isArchived) {
                note.isArchived = true;
                note.updatedAt = Date.now();
                if (draft.uiState.selectedNoteId === action.payload.noteId) {
                    draft.uiState.selectedNoteId = null;
                }
            }
            break;
        }

        case 'CORE_DELETE_NOTE': {
            const {noteId} = action.payload;
            const noteToDelete = draft.notes[noteId];
            if (!noteToDelete) break;

            // Update systemNoteIndex if necessary
            if (noteToDelete.systemType && draft.systemNoteIndex[noteToDelete.systemType] === noteId) {
                delete draft.systemNoteIndex[noteToDelete.systemType];
            }

            // Remove from order
            draft.noteOrder = draft.noteOrder.filter(id => id !== noteId);
            // Remove from notes map
            delete draft.notes[noteId];

            // Update selection if needed
            if (draft.uiState.selectedNoteId === noteId) {
                draft.uiState.selectedNoteId = null; // Or select next/previous? Null is simpler.
            }
            break;
        }

        case 'CORE_SEARCH_TERM_CHANGED': {
            draft.uiState.searchTerm = action.payload.searchTerm;
            break;
        }

        case 'CORE_OPEN_MODAL': {
            draft.uiState.activeModal = action.payload.modalId;
            break;
        }
        case 'CORE_CLOSE_MODAL': {
            draft.uiState.modalType = null;
            draft.uiState.modalProps = null;
            // Clear validation errors when any modal closes
            draft.uiState.propertyValidationErrors = {};
            break;
        }

        case 'CORE_SET_CORE_SETTING': {
            const {key, value} = action.payload;
            if (draft.settings.core.hasOwnProperty(key)) {
                draft.settings.core[key] = value;
            } else {
                console.warn(`CORE_SET_CORE_SETTING: Ignoring unknown core setting key '${key}'`);
            }
            break;
        }

        // CORE_SET_PLUGIN_SETTING is REMOVED by Enhancement #0

        case 'CORE_SET_GLOBAL_STATUS': {
            const {message, type = 'info', duration = 5000, id = null} = action.payload;
            const statusPayload = {message, type, duration};
            if (id) {
                if (!draft.uiState.globalStatusMessages) draft.uiState.globalStatusMessages = {};
                draft.uiState.globalStatusMessages[id] = statusPayload;
                // Optionally clear the main status if setting a specific one? Or let them coexist? Let them coexist for now.
            } else {
                draft.uiState.globalStatus = statusPayload;
            }
            break;
        }
        case 'CORE_CLEAR_GLOBAL_STATUS': {
            const {id = null} = action.payload || {}; // Handle payload possibly being undefined
            if (id) {
                if (draft.uiState.globalStatusMessages) {
                    delete draft.uiState.globalStatusMessages[id];
                }
            } else {
                draft.uiState.globalStatus = null;
            }
            break;
        }

        case 'CORE_SET_RUNTIME_CACHE': {
            const {key, value} = action.payload;
            draft.runtimeCache[key] = value;
            break;
        }
        case 'CORE_DELETE_RUNTIME_CACHE': {
            const {key} = action.payload;
            delete draft.runtimeCache[key];
            break;
        }

        case 'CORE_STATE_CLEARED': {
            // Reset state to initial after data wipe
            Object.assign(draft, initialAppState);
            draft.uiState.globalStatus = {
                message: "Local data cleared. Reloading recommended.",
                type: 'warning',
                duration: 0
            };
            // Clear validation error for the specific property on successful update
            if (draft.uiState.propertyValidationErrors?.[noteId]?.[propertyId]) {
                delete draft.uiState.propertyValidationErrors[noteId][propertyId];
                if (Object.keys(draft.uiState.propertyValidationErrors[noteId]).length === 0) {
                    delete draft.uiState.propertyValidationErrors[noteId];
                }
            }
            break;
        }

        // --- Property Validation Failure ---
        case 'PROPERTY_VALIDATION_FAILURE': {
            const { noteId, propertyId, temporaryId, errorMessage } = action.payload;
            const idToUse = propertyId || temporaryId; // Use real ID if available, else temporary
            if (!idToUse) break; // Need an ID to associate the error

            if (!draft.uiState.propertyValidationErrors) draft.uiState.propertyValidationErrors = {};
            if (!draft.uiState.propertyValidationErrors[noteId]) draft.uiState.propertyValidationErrors[noteId] = {};
            draft.uiState.propertyValidationErrors[noteId][idToUse] = errorMessage;
            break;
        }

        // --- Added for Enhancement #2 (Priority Sort) ---
        case 'CORE_SET_NOTE_LIST_SORT_MODE': {
            const newMode = action.payload;
            if (newMode === 'time' || newMode === 'priority') {
                if (draft.uiState.noteListSortMode !== newMode) {
                    draft.uiState.noteListSortMode = newMode;
                    // Notify listeners - state change handled by Immer/StateManager
                }
            }
            break;
        }

        default:
            break;
    }
};

async function main() {
    console.log("%cInitializing Core...", "color: orange; font-size: 150%; font-weight: bold;");
    let api = null;

    try {
        // Initialize Core Services
        const events = new EventBus();
        const state = new StateManager(initialAppState, coreReducer);
        const ui = new UIRenderer(state, 'app');
        const plugins = new PluginManager(state, ui, events);
        const persistence = new PersistenceService(state);

        api = plugins._coreAPI; // Get the created instance

        // Expose Debug Globals
        window.realityNotebookCore = api;
        window._getState = state.getState.bind(state);
        window._dispatch = state.dispatch.bind(state);
        window._clearState = persistence.clearState.bind(persistence); // Expose clear function

        // Load Initial State
        api.showGlobalStatus("Loading saved data...", "info");
        let loadedState = null;
        try {
            loadedState = await persistence.loadState();
            // Dispatch action to merge loaded state and reset transient fields
            state.dispatch({type: 'CORE_STATE_LOADED', payload: {loadedState}});
            if (loadedState) {
                api.showGlobalStatus("Data loaded.", "success", 1500);
            } else {
                api.showGlobalStatus("No saved data found, starting fresh.", "info", 2000);
            }
        } catch (loadError) {
            console.error("Core: Failed to load persistent state.", loadError);
            // Dispatch with null state to initialize default structure
            state.dispatch({type: 'CORE_STATE_LOADED', payload: {loadedState: null}});
            api.showGlobalStatus("Error loading data. Starting with default state.", "error", 5000);
            // Optionally render a more persistent error message if loading fails critically
        }

        // Register Plugins
        plugins.registerPlugins(PLUGINS);

        // Activate Plugins
        api.showGlobalStatus("Initializing plugins...", "info");
        try {
            plugins.activatePlugins(); // Handles dependency sort, lifecycle methods
            // Status messages for success/failure are handled within activatePlugins
        } catch (activationError) {
            // This catch is mostly for synchronous errors during the activation loop setup,
            // individual plugin errors are caught inside activatePlugins.
            console.error("Core: Critical error during plugin activation phase.", activationError);
            api.showGlobalStatus(`Critical plugin activation error: ${activationError.message}`, "error", 0); // Persistent error
        }

        // Initial Render is triggered by CORE_STATE_LOADED state change via UIRenderer subscription.

        console.log("%cNetention Core Initialized Successfully.", "color: green; font-weight: bold;");
        api.showGlobalStatus("Application Ready", "success", 2000);

        // Post-initialization (Example: Trigger onboarding check)
        // if (!stateManager.getState().settings.core.onboardingComplete) {
        //     stateManager.dispatch({ type: 'ONBOARDING_CHECK_START' }); // Action handled by onboarding plugin
        // }
    } catch (error) {
        console.error("%cCRITICAL ERROR DURING INITIALIZATION:", "color: red; font-weight: bold;", error);
        const appRoot = document.getElementById('app');
        if (appRoot) {
            render(html`
                <div class="error-display">
                    <h1>Initialization Failed</h1>
                    <p>The application could not start due to a critical error.</p>
                    <pre>${Utils.sanitizeHTML(error.stack)}</pre>
                    <p>Please check the console for more details or try clearing application data.</p>
                </div>`, appRoot);
        }
    }
}


if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main); else await main();
