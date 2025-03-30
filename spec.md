This version incorporates the feedback, clarifies implementation details, adds mechanisms for configuration (System
Notes) and editor integration, ensures better support for all plugin types, and emphasizes robustness.

```javascript
/**
 * Reality Notebook v10.1 - Refined Hybrid Specification (Core & Plugin Interface)
 *
 * Focus: Viability, Completeness, Plugin Support. Core is functional standalone.
 */

// ==========================================================================
// 0. Core Constants & Types (Conceptual Refinements)
// ==========================================================================

// UI Slots remain the same...
const SLOT_MAIN_LAYOUT = 'mainLayout';
const SLOT_SIDEBAR_HEADER = 'sidebarHeader';
const SLOT_SIDEBAR_NOTE_LIST_ACTIONS = 'sidebarNoteListActions';
const SLOT_NOTE_LIST_ITEM_STATUS = 'noteListItemStatus';
const SLOT_NOTE_LIST_ITEM_META = 'noteListItemMeta';
const SLOT_EDITOR_HEADER_ACTIONS = 'editorHeaderActions';
const SLOT_EDITOR_CONTENT_AREA = 'editorContentArea'; // Critical slot for Editor Plugin
const SLOT_EDITOR_BELOW_CONTENT = 'editorBelowContent';
const SLOT_EDITOR_PLUGIN_PANELS = 'editorPluginPanels';
const SLOT_SETTINGS_PANEL_SECTION = 'settingsPanelSection';
const SLOT_APP_STATUS_BAR = 'appStatusBar'; // Added for global status messages

// Basic Action Type Structure
// interface Action { type: string; payload?: any; error?: boolean; meta?: any; }

// --- Core Note Structure (Minimal + System Type) ---
// interface CoreNote {
//   id: string; // UUID
//   name: string;
//   content: string; // Handled by core or Editor Plugin
//   createdAt: number; // Unix ms timestamp
//   updatedAt: number; // Unix ms timestamp
//   isArchived: boolean; // Core flag
//   systemType: string | null; // Added for System Notes (e.g., 'plugin/nostr/relays')
//   // --- Fields below are added dynamically by plugins via reducers/middleware ---
//   // Properties added by PropertiesPlugin listeners/reducers reacting to CORE_ADD_NOTE etc.
//   // properties?: Array<Property>;
//   // pluginData?: { [pluginId: string]: any }; // Added/managed by specific plugin reducers
// }

// --- Core App State Structure (Refined) ---
// interface AppState {
//   notes: { [id: string]: CoreNote }; // Notes indexed by ID
//   noteOrder: string[]; // Array of note IDs for display order
//   systemNoteIndex: { // Added index for fast System Note lookup
//       [systemType: string]: string | null; // Maps systemType to noteId
//   };
//   settings: {
//     core: {
//       theme: string;
//       userId?: string; // Optional anonymous user ID for analytics/sync
//     };
//     plugins: { // Static configuration, managed via CORE_SET_PLUGIN_SETTING
//       [pluginId: string]: any;
//     };
//   };
//   uiState: { // Transient UI state, mostly NOT persisted
//     selectedNoteId: string | null;
//     searchTerm: string;
//     activeModal: string | null; // e.g., 'settings', 'confirmDelete'
//     globalStatus: { message: string, type: 'info'|'error'|'success', duration?: number } | null;
//     // Other transient states like loading indicators specific to core UI parts
//   };
//   pluginRuntimeState: { // Transient state managed entirely by plugins (NOT persisted)
//     [pluginId: string]: any;
//   };
//   runtimeCache: { // Semi-persistent cache (persisted), managed by plugins (e.g., profiles)
//       [cacheKey: string]: any;
//   };
// }

// ==========================================================================
// 1. Core Application Components (Refined)
// ==========================================================================

/**
 * Manages the application's state. (Largely similar, emphasize pure reducers)
 * Reducers MUST be pure functions. Async operations happen in middleware or action creators.
 */
class StateManager {
    _state = {};
    _coreReducers = {}; // { [actionType]: function(state, action) } - Core handles its own slice
    _pluginReducers = {}; // { [pluginId]: function(state, action) } - Plugins handle the *entire* state
    _middleware = [];
    _listeners = new Set();
    _dispatchChain = null; // Rebuilt when middleware changes

    constructor(initialState, coreReducers) {
        this._state = initialState;
        this._coreReducers = coreReducers; // Store core reducers separately for clarity
        this._dispatchChain = this._buildDispatchChain(); // Build initial chain
    }

    // getState, subscribe, _notifyListeners remain similar

    getStoreApi() {
        return {
            getState: this.getState.bind(this),
            dispatch: (action) => this._dispatchChain(action),
        };
    }

    _buildDispatchChain() {
        console.log(`StateManager: Rebuilding dispatch chain with ${this._middleware.length} middleware.`);
        return this._middleware.reduceRight(
            (next, mw) => mw(this.getStoreApi())(next),
            this._baseDispatch.bind(this)
        );
    }

    _baseDispatch(action) {
        const oldState = this._state;
        let nextState = oldState;

        // Apply core reducer first (operates primarily on core state slices)
        if (this._coreReducers[action.type]) {
            try {
                nextState = this._coreReducers[action.type](nextState, action);
            } catch (error) {
                console.error(`StateManager: Error in core reducer for action [${action.type}]`, error, action);
                // Optionally dispatch an error action
            }
        }

        // Apply all plugin reducers (they receive the *full* state)
        Object.entries(this._pluginReducers).forEach(([pluginId, reducerFn]) => {
            try {
                nextState = reducerFn(nextState, action); // Plugin reducer handles relevant changes
            } catch (error) {
                console.error(`StateManager: Error in plugin reducer for [${pluginId}] on action [${action.type}]`, error, action);
                // Optionally dispatch an error action, disable plugin?
            }
        });


        if (nextState !== oldState) {
            this._state = nextState;
            // console.log(`State updated by action: ${action.type}`, action.payload); // Debugging
            this._notifyListeners(oldState);
        } else {
            // console.log(`Action ${action.type} did not change state.`); // Debugging
        }
        return action;
    }

    dispatch(action) {
        // Input validation for action? { type: string } must exist.
        if (!action || typeof action.type !== 'string') {
            console.error("StateManager: Invalid action dispatched.", action);
            return;
        }
        return this._dispatchChain(action);
    }

    // --- Methods called by PluginManager ---
    registerReducer(pluginId, reducerFn) {
        // Each plugin provides ONE top-level reducer function.
        // This reducer is responsible for handling ALL actions relevant to the plugin
        // across the entire state object (including its own pluginRuntimeState, settings, note.pluginData etc).
        if (this._pluginReducers[pluginId]) {
            console.warn(`StateManager: Reducer already registered for plugin [${pluginId}]. Overwriting.`);
        }
        this._pluginReducers[pluginId] = reducerFn;
        console.log(`StateManager: Registered main reducer for plugin [${pluginId}]`);
    }

    registerMiddleware(pluginId, middlewareFn) {
        this._middleware.push(middlewareFn);
        this._dispatchChain = this._buildDispatchChain(); // Rebuild chain immediately
        console.log(`StateManager: Registered middleware from plugin [${pluginId}]`);
    }
}

/**
 * Handles plugin lifecycle, service registry, CoreAPI provision. (Refined)
 */
class PluginManager {
    _pluginRegistry = new Map(); // Map<pluginId, { definition, instance, isActive, status: 'registered'|'activating'|'active'|'error'|'deactivated', error?: Error }>
    _pluginLoadOrder = [];
    _coreAPI = null;
    _stateManager = null;
    _uiRenderer = null;
    _eventBus = null;
    _services = new Map(); // Map<serviceName, { instance, providerPluginId }>

    constructor(stateManager, uiRenderer, eventBus) {
        // ... constructor similar ...
        this._coreAPI = new CoreAPI(stateManager, this, uiRenderer, eventBus);
    }

    registerPlugin(pluginDefinition) {
        // ... validation similar ...
        const entry = {
            definition: pluginDefinition,
            instance: null,
            isActive: false,
            status: 'registered',
            error: null,
            api: null
        };
        this._pluginRegistry.set(pluginDefinition.id, entry);
        console.log(`PluginManager: Registered plugin definition [${pluginDefinition.id}]`);
    }

    _calculateLoadOrder() {
        // TODO: Implement topological sort based on `dependencies` in plugin definitions.
        // For now, assume registration order is okay or manually ensure correct order.
        this._pluginLoadOrder = Array.from(this._pluginRegistry.keys());
    }

    activatePlugins() {
        this._calculateLoadOrder();
        console.log('PluginManager: Activating plugins in order:', this._pluginLoadOrder);

        this._pluginLoadOrder.forEach(pluginId => {
            const entry = this._pluginRegistry.get(pluginId);
            if (!entry || entry.status !== 'registered') return; // Skip already processed or invalid

            // Check dependencies (basic check for now)
            const deps = entry.definition.dependencies || [];
            let depsMet = true;
            for (const depId of deps) {
                const depEntry = this._pluginRegistry.get(depId);
                if (!depEntry || depEntry.status !== 'active') {
                    console.error(`PluginManager: Dependency [${depId}] not met or not active for plugin [${pluginId}]. Skipping activation.`);
                    entry.status = 'error';
                    entry.error = new Error(`Dependency not met: ${depId}`);
                    depsMet = false;
                    break;
                }
            }
            if (!depsMet) return;

            entry.status = 'activating';
            console.log(`PluginManager: Activating plugin [${pluginId}]...`);

            try {
                // Instantiate plugin (treat definition as instance for simplicity)
                entry.instance = entry.definition;

                // 1. Initialize Plugin (core API is ready)
                entry.instance.init(this._coreAPI);

                // 2. Register Reducer (Single reducer per plugin now)
                if (typeof entry.instance.registerReducer === 'function') {
                    const reducer = entry.instance.registerReducer();
                    if (typeof reducer === 'function') {
                        this._stateManager.registerReducer(pluginId, reducer);
                    } else {
                        console.warn(`PluginManager: Plugin [${pluginId}] registerReducer did not return a function.`);
                    }
                }

                // 3. Register Middleware
                if (typeof entry.instance.registerMiddleware === 'function') {
                    const middleware = entry.instance.registerMiddleware();
                    if (middleware) { // Ensure it returned something
                        this._stateManager.registerMiddleware(pluginId, middleware);
                    }
                }

                // 4. Register UI Slots
                if (typeof entry.instance.registerUISlots === 'function') {
                    const slots = entry.instance.registerUISlots() || {};
                    Object.entries(slots).forEach(([slotName, renderFn]) => {
                        if (typeof renderFn === 'function') {
                            this._uiRenderer.registerSlotComponent(pluginId, slotName, renderFn);
                        } else {
                            console.warn(`PluginManager: Invalid render function provided for slot [${slotName}] by plugin [${pluginId}]`);
                        }
                    });
                }

                // 5. Register Services
                if (typeof entry.instance.providesServices === 'function') {
                    const services = entry.instance.providesServices() || {};
                    Object.entries(services).forEach(([serviceName, serviceInstance]) => {
                        this.registerService(pluginId, serviceName, serviceInstance);
                    });
                }

                // 6. Get Plugin's Exposed API
                if (typeof entry.instance.getAPI === 'function') {
                    entry.api = entry.instance.getAPI();
                }

                // 7. Call onActivate lifecycle hook
                if (typeof entry.instance.onActivate === 'function') {
                    entry.instance.onActivate();
                }

                entry.isActive = true;
                entry.status = 'active';
                console.log(`PluginManager: Successfully activated plugin [${pluginId}]`);
                this._eventBus.publish('PLUGIN_STATUS_CHANGED', {pluginId, status: 'active'});

            } catch (error) {
                console.error(`PluginManager: Failed to activate plugin [${pluginId}]`, error);
                entry.status = 'error';
                entry.error = error;
                entry.isActive = false;
                this._eventBus.publish('PLUGIN_STATUS_CHANGED', {pluginId, status: 'error', error: error.message});
                // Optional: Clean up partially registered stuff (reducers, middleware, slots?) - complex
            }
        });
    }

    // --- Service Registry ---
    registerService(pluginId, serviceName, serviceInstance) {
        if (!serviceInstance || typeof serviceInstance !== 'object') {
            console.error(`PluginManager: Invalid service instance provided for [${serviceName}] by plugin [${pluginId}].`);
            return;
        }
        if (this._services.has(serviceName)) {
            const existingProvider = this._services.get(serviceName).providerPluginId;
            console.warn(`PluginManager: Service [${serviceName}] already registered by plugin [${existingProvider}]. Overwriting by plugin [${pluginId}].`);
        }
        this._services.set(serviceName, {instance: serviceInstance, providerPluginId: pluginId});
        console.log(`PluginManager: Registered service [${serviceName}] from plugin [${pluginId}]`);
    }

    getService(serviceName) {
        const entry = this._services.get(serviceName);
        return entry ? entry.instance : null;
    }

    // getPluginAPI remains similar

    // TODO: Add deactivatePlugin(pluginId) method for cleanup and resource release.
}

/**
 * Handles persistence. (Refined filtering)
 */
class PersistenceService {
    // ... constructor, loadState similar ...
    _localForage = window.localforage; // Assume available

    constructor(stateManager) {
        this._stateManager = stateManager;
        if (!this._localForage) {
            console.error("PersistenceService: localForage not found. Persistence disabled.");
            return; // Disable persistence if library isn't loaded
        }
        this._stateManager.subscribe(Utils.debounce(this.handleStateChange.bind(this), 1000));
    }

    handleStateChange(newState) {
        if (!this._localForage) return;
        this.saveState(newState);
    }

    async saveState(state) {
        if (!this._localForage) return;
        if (this._isSaving) return;
        this._isSaving = true;
        try {
            const stateToSave = this.filterStateForSaving(state);
            await this._localForage.setItem(this._storageKey, stateToSave);
            // console.log('PersistenceService: State saved.');
        } catch (error) {
            console.error('PersistenceService: Error saving state', error);
        } finally {
            this._isSaving = false;
        }
    }

    filterStateForSaving(state) {
        // Explicitly exclude transient state
        const {
            uiState,             // Exclude all transient UI state
            pluginRuntimeState,  // Exclude all plugin runtime state
            ...stateToSave        // Keep the rest
        } = state;

        // Optionally, filter parts of uiState if some ARE persistent (e.g., sidebar width)
        // For now, exclude all of it for simplicity.

        return stateToSave;
    }
}

/**
 * Renders UI, manages slots. (Refined error handling, status bar)
 */
class UIRenderer {
    // ... constructor, _slotRegistry similar ...

    renderApp(newState) {
        const state = newState || this._stateManager.getState();
        try {
            this._rootElement.innerHTML = this.renderMainLayout(state); // Render shell
            this.renderSlots(state); // Render plugin components into slots
            this.attachCoreListeners(state); // Attach core listeners
        } catch (error) {
            console.error("UIRenderer: CRITICAL ERROR during renderApp!", error);
            this._rootElement.innerHTML = `<div style="color:red; border: 2px solid red; padding: 10px;">
                <h1>Application Render Error</h1><pre>${error.stack}</pre>
                <p>Please check console for details. State might be corrupted.</p>
            </div>`;
        }
    }

    renderSlots(state) {
        Object.entries(this._slotRegistry).forEach(([slotName, components]) => {
            // Find potentially multiple elements matching the slot selector
            const slotContainers = this._rootElement.querySelectorAll(`[data-slot="${slotName}"]`);
            slotContainers.forEach(slotContainer => {
                slotContainer.innerHTML = ''; // Clear previous content
                components.forEach(({pluginId, renderFn}) => {
                    try {
                        // Pass relevant props based on slot context if needed
                        const props = {
                            state,
                            dispatch: this._stateManager.dispatch.bind(this._stateManager),
                            // Pass noteId if the slot is context-specific
                            noteId: slotContainer.dataset.noteId || state.uiState.selectedNoteId || null,
                        };
                        const element = renderFn(props);
                        if (element instanceof Node) { // Check if it's a DOM Node
                            slotContainer.appendChild(element);
                        } else if (typeof element === 'string') {
                            slotContainer.insertAdjacentHTML('beforeend', element);
                        } else if (element) {
                            console.warn(`UIRenderer: Slot [${slotName}] renderFn from [${pluginId}] returned non-renderable type:`, element);
                        }
                    } catch (error) {
                        console.error(`UIRenderer: Error rendering slot [${slotName}] by plugin [${pluginId}]`, error);
                        slotContainer.innerHTML += `<div style="color:red; border: 1px solid red; padding: 2px; font-size: 0.8em;">Error in ${pluginId}</div>`;
                    }
                });
            });
        });
    }

    renderMainLayout(state) {
        // Refined layout including settings button and status bar slot
        const selectedNote = state.uiState.selectedNoteId ? state.notes[state.uiState.selectedNoteId] : null;

        return `
            <div class="app-container">
                <div id="sidebar" class="sidebar">
                    <div class="sidebar-header" data-slot="${SLOT_SIDEBAR_HEADER}">
                        <input type="search" id="core-search" placeholder="Search..." value="${state.uiState.searchTerm || ''}">
                        <button id="core-open-settings" title="Settings">⚙️</button> <!-- Settings Trigger -->
                    </div>
                    <div class="sidebar-actions" data-slot="${SLOT_SIDEBAR_NOTE_LIST_ACTIONS}">
                         <button id="core-add-note" title="Add Note">➕ Add Note</button>
                    </div>
                    <ul id="note-list" class="note-list">
                        ${this.renderNoteListItems(state)}
                    </ul>
                </div>
                <div id="main-content-area" class="main-content-area">
                    <div id="editor-area" class="editor-area">
                         ${selectedNote ? this.renderEditorArea(state, selectedNote) : this.renderWelcomeMessage(state)}
                    </div>
                    <div id="status-bar" class="status-bar" data-slot="${SLOT_APP_STATUS_BAR}">
                        <!-- Core Status Message -->
                        <span class="core-status">${state.uiState.globalStatus?.message || 'Ready'}</span>
                        <!-- Plugin status indicators rendered here -->
                    </div>
                </div>
                 <div id="modal-root"> <!-- Modal container -->
                     ${this._renderModal(state)}
                 </div>
            </div>
        `;
    }

    // renderNoteListItems, renderEditorArea, renderWelcomeMessage similar...

    renderSettingsModal(state) {
        return `
            <div id="modal-backdrop" class="modal-backdrop"></div>
            <div id="settings-view" class="modal-content settings-view" role="dialog" aria-modal="true" aria-labelledby="settings-title">
                 <h2 id="settings-title">Settings</h2>
                 <button id="core-close-settings" class="modal-close-button" aria-label="Close Settings">×</button>
                 <div class="settings-core">
                     <h3>Core</h3>
                     <label>Theme:
                        <select id="core-theme-select" data-setting-key="theme">
                            <option value="light" ${state.settings.core.theme === 'light' ? 'selected' : ''}>Light</option>
                            <option value="dark" ${state.settings.core.theme === 'dark' ? 'selected' : ''}>Dark</option>
                        </select>
                     </label>
                 </div>
                 <div class="settings-plugins" data-slot="${SLOT_SETTINGS_PANEL_SECTION}">
                     <!-- Plugin settings sections rendered here -->
                 </div>
            </div>
         `;
    }


    attachCoreListeners(state) {
        // Use event delegation where possible for performance
        this._rootElement.removeEventListener('click', this._handleCoreClicks); // Remove old listener
        this._rootElement.addEventListener('click', this._handleCoreClicks.bind(this));

        this._rootElement.removeEventListener('input', this._handleCoreInputs); // Remove old listener
        this._rootElement.addEventListener('input', this._handleCoreInputs.bind(this));

        // Handle modal backdrop clicks specifically if needed (or via delegation)
        const modalBackdrop = this._rootElement.querySelector('#modal-backdrop');
        if (modalBackdrop) {
            modalBackdrop.onclick = () => this._stateManager.dispatch({type: 'CORE_CLOSE_MODAL'});
        }
    }

    // --- Delegated Event Handlers ---
    _handleCoreClicks(event) {
        const target = event.target;
        const state = this._stateManager.getState(); // Get fresh state

        // Note List Item Click
        const listItem = target.closest('.note-list-item');
        if (listItem && listItem.dataset.noteId) {
            event.preventDefault();
            this._stateManager.dispatch({type: 'CORE_SELECT_NOTE', payload: {noteId: listItem.dataset.noteId}});
            return;
        }
        // Add Note Button
        if (target.matches('#core-add-note')) {
            this._stateManager.dispatch({type: 'CORE_ADD_NOTE'});
            return;
        }
        // Settings Buttons
        if (target.matches('#core-open-settings')) {
            this._stateManager.dispatch({type: 'CORE_OPEN_MODAL', payload: {modalId: 'settings'}});
            return;
        }
        if (target.matches('#core-close-settings') || target.closest('#core-close-settings')) {
            this._stateManager.dispatch({type: 'CORE_CLOSE_MODAL'});
            return;
        }
        // Archive Button
        const archiveBtn = target.closest('.core-archive-note');
        if (archiveBtn && archiveBtn.dataset.noteId) {
            const noteId = archiveBtn.dataset.noteId;
            this._stateManager.dispatch({type: 'CORE_ARCHIVE_NOTE', payload: {noteId: noteId}});
            return;
        }
        // Delete Button
        const deleteBtn = target.closest('.core-delete-note');
        if (deleteBtn && deleteBtn.dataset.noteId) {
            const noteId = deleteBtn.dataset.noteId;
            if (confirm(`Are you sure you want to delete note "${state.notes[noteId]?.name || 'Untitled'}"?`)) {
                this._stateManager.dispatch({type: 'CORE_DELETE_NOTE', payload: {noteId: noteId}});
            }
            return;
        }
        // Add other core button handlers...
    }

    _handleCoreInputs(event) {
        const target = event.target;
        const state = this._stateManager.getState(); // Get fresh state

        // Search Input
        if (target.matches('#core-search')) {
            Utils.debounce(() => {
                this._stateManager.dispatch({type: 'CORE_SEARCH_TERM_CHANGED', payload: {searchTerm: target.value}});
            }, 300)();
            return;
        }
        // Editor Title Input
        if (target.matches('.editor-title-input') && target.dataset.noteId) {
            const noteId = target.dataset.noteId;
            Utils.debounce(() => {
                this._stateManager.dispatch({
                    type: 'CORE_UPDATE_NOTE',
                    payload: {noteId: noteId, changes: {name: target.value}}
                });
            }, 500)();
            return;
        }
        // Core Content Textarea
        if (target.matches('.core-content-editor') && target.dataset.noteId) {
            const noteId = target.dataset.noteId;
            Utils.debounce(() => {
                this._stateManager.dispatch({
                    type: 'CORE_UPDATE_NOTE',
                    payload: {noteId: noteId, changes: {content: target.value}}
                });
            }, 500)();
            return;
        }
        // Core Settings Inputs (Example for Theme)
        if (target.matches('#core-theme-select') && target.dataset.settingKey) {
            const key = target.dataset.settingKey;
            const value = target.value;
            this._stateManager.dispatch({type: 'CORE_SET_CORE_SETTING', payload: {key, value}});
            // Apply theme change immediately? Or via state subscription effect
            document.documentElement.setAttribute('data-theme', value); // Example immediate effect
            return;
        }

        // Add other core input handlers...
    }

    // registerSlotComponent, renderEphemeralComponent similar...
}

/**
 * Event Bus (No major changes needed)
 */
class EventBus {
    // ... implementation similar ...
}

/**
 * Utilities (Add Sanitization Placeholder)
 */
const Utils = {
    // generateUUID, debounce similar...
    sanitizeHTML: (dirtyHTMLString) => {
        // **IMPORTANT**: Replace this with DOMPurify in a real application!
        // This placeholder is NOT secure.
        if (typeof DOMPurify !== 'undefined') {
            return DOMPurify.sanitize(dirtyHTMLString);
        } else {
            console.warn("Utils.sanitizeHTML: DOMPurify not found. Falling back to basic text conversion (UNSAFE).");
            const temp = document.createElement('div');
            temp.textContent = dirtyHTMLString; // Convert HTML to text content
            return temp.innerHTML;
        }
    },
    // Add other needed utils: throttle, date formatting, deepClone, etc.
    throttle: (func, limit) => {
        let lastFunc;
        let lastRan;
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
};

// ==========================================================================
// 2. Core Data Model & Reducers (Refined)
// ==========================================================================

const initialAppState = { // Default structure
    notes: {},
    noteOrder: [],
    systemNoteIndex: {},
    settings: {
        core: {theme: 'light', userId: null},
        plugins: {}
    },
    uiState: {
        selectedNoteId: null,
        searchTerm: '',
        activeModal: null,
        globalStatus: null,
    },
    pluginRuntimeState: {},
    runtimeCache: {},
};

// --- Core Reducer (Handles only core state slices primarily) ---
const coreReducer = (state = initialAppState, action) => {
    switch (action.type) {
        case 'CORE_STATE_LOADED': {
            const loaded = action.payload.loadedState || {};
            // Carefully merge, ensuring all expected keys exist and transient state is reset
            return {
                ...initialAppState, // Start with defaults
                // Merge persisted parts
                notes: loaded.notes || {},
                noteOrder: loaded.noteOrder || [],
                systemNoteIndex: loaded.systemNoteIndex || {}, // Load index if persisted
                settings: {
                    core: {...initialAppState.settings.core, ...(loaded.settings?.core || {})},
                    plugins: loaded.settings?.plugins || {}
                },
                runtimeCache: loaded.runtimeCache || {}, // Load cache
                // Reset transient parts explicitly
                uiState: {
                    ...initialAppState.uiState,
                    // Potentially restore some non-sensitive UI state if desired, e.g., sidebar state
                },
                pluginRuntimeState: {}, // Always reset plugin runtime state
            };
        }

        case 'CORE_ADD_NOTE': {
            const newNoteId = Utils.generateUUID();
            const now = Date.now();
            const newNote = {
                id: newNoteId,
                name: action.payload?.name || 'New Note', // Allow initial name override
                content: action.payload?.content || '',
                createdAt: now,
                updatedAt: now,
                isArchived: false,
                systemType: action.payload?.systemType || null, // Allow setting system type on creation
                // Core doesn't add pluginData here. Plugins react via their reducers.
            };
            const newNotes = {...state.notes, [newNoteId]: newNote};
            const newNoteOrder = [newNoteId, ...state.noteOrder];
            const newSystemNoteIndex = newNote.systemType
                ? {...state.systemNoteIndex, [newNote.systemType]: newNoteId}
                : state.systemNoteIndex;

            return {
                ...state,
                notes: newNotes,
                noteOrder: newNoteOrder,
                systemNoteIndex: newSystemNoteIndex,
                uiState: {...state.uiState, selectedNoteId: newNoteId}
            };
        }

        case 'CORE_SELECT_NOTE': {
            const {noteId} = action.payload;
            if (!state.notes[noteId] || state.uiState.selectedNoteId === noteId) return state;
            return {...state, uiState: {...state.uiState, selectedNoteId: noteId}};
        }

        case 'CORE_UPDATE_NOTE': {
            const {noteId, changes} = action.payload;
            if (!state.notes[noteId]) return state;
            // Core only updates core fields + updatedAt
            const coreChanges = {};
            if (changes.hasOwnProperty('name')) coreChanges.name = changes.name;
            if (changes.hasOwnProperty('content')) coreChanges.content = changes.content;
            if (changes.hasOwnProperty('isArchived')) coreChanges.isArchived = changes.isArchived;
            // SystemType changes require index update
            const oldSystemType = state.notes[noteId].systemType;
            const newSystemType = changes.hasOwnProperty('systemType') ? changes.systemType : oldSystemType;
            if (changes.hasOwnProperty('systemType')) coreChanges.systemType = newSystemType;

            if (Object.keys(coreChanges).length === 0) return state; // No core changes

            const updatedNote = {
                ...state.notes[noteId],
                ...coreChanges,
                updatedAt: Date.now()
            };
            const newNotes = {...state.notes, [noteId]: updatedNote};
            let newSystemNoteIndex = state.systemNoteIndex;
            if (newSystemType !== oldSystemType) {
                newSystemNoteIndex = {...state.systemNoteIndex};
                if (oldSystemType) delete newSystemNoteIndex[oldSystemType];
                if (newSystemType) newSystemNoteIndex[newSystemType] = noteId;
            }

            return {...state, notes: newNotes, systemNoteIndex: newSystemNoteIndex};
            // Note: Plugin fields are NOT handled here. Plugins handle their own data via their reducers.
        }

        case 'CORE_ARCHIVE_NOTE': {
            // Delegate to CORE_UPDATE_NOTE for consistency
            return coreReducer(state, {
                type: 'CORE_UPDATE_NOTE',
                payload: {noteId: action.payload.noteId, changes: {isArchived: true}}
            });
        }

        case 'CORE_DELETE_NOTE': {
            const {noteId} = action.payload;
            if (!state.notes[noteId]) return state;
            const noteToDelete = state.notes[noteId];
            const {[noteId]: _, ...remainingNotes} = state.notes;
            const newNoteOrder = state.noteOrder.filter(id => id !== noteId);
            let newSystemNoteIndex = state.systemNoteIndex;
            if (noteToDelete.systemType && state.systemNoteIndex[noteToDelete.systemType] === noteId) {
                newSystemNoteIndex = {...state.systemNoteIndex};
                delete newSystemNoteIndex[noteToDelete.systemType];
            }

            return {
                ...state,
                notes: remainingNotes,
                noteOrder: newNoteOrder,
                systemNoteIndex: newSystemNoteIndex,
                uiState: {
                    ...state.uiState,
                    selectedNoteId: state.uiState.selectedNoteId === noteId ? null : state.uiState.selectedNoteId
                }
            };
        }

        case 'CORE_SEARCH_TERM_CHANGED': {
            return {...state, uiState: {...state.uiState, searchTerm: action.payload.searchTerm}};
        }

        case 'CORE_OPEN_MODAL': {
            draft.uiState.modalType = action.payload.modalType;
            draft.uiState.modalProps = action.payload.modalProps || {}; // Store props for the modal
            break;
        }
        case 'CORE_CLOSE_MODAL': {
            draft.uiState.modalType = null;
            draft.uiState.modalProps = null;
            break;
        }

        case 'CORE_SET_CORE_SETTING': {
            const {key, value} = action.payload;
            // Basic validation: ensure key is allowed?
            // const allowedKeys = ['theme', 'userId']; if (!allowedKeys.includes(key)) return state;
            return {
                ...state,
                settings: {
                    ...state.settings,
                    core: {...state.settings.core, [key]: value}
                }
            };
        }

        case 'CORE_SET_PLUGIN_SETTING': { // For plugins to save their own static settings
            const {pluginId, key, value} = action.payload;
            if (!pluginId || !key) return state; // Basic validation
            return {
                ...state,
                settings: {
                    ...state.settings,
                    plugins: {
                        ...state.settings.plugins,
                        [pluginId]: {
                            ...(state.settings.plugins[pluginId] || {}),
                            [key]: value
                        }
                    }
                }
            };
        }

        case 'CORE_SET_GLOBAL_STATUS': {
            const {message, type = 'info', duration = 5000} = action.payload;
            return {
                ...state,
                uiState: {
                    ...state.uiState,
                    globalStatus: {message, type, duration}
                }
            };
        }
        case 'CORE_CLEAR_GLOBAL_STATUS': {
            if (!state.uiState.globalStatus) return state;
            return {...state, uiState: {...state.uiState, globalStatus: null}};
        }

        case 'CORE_SET_RUNTIME_CACHE': { // For plugins to manage cached data (e.g., profiles)
            const {key, value} = action.payload;
            return {
                ...state,
                runtimeCache: {
                    ...state.runtimeCache,
                    [key]: value
                }
            };
        }
        case 'CORE_DELETE_RUNTIME_CACHE': {
            const {key} = action.payload;
            if (!state.runtimeCache.hasOwnProperty(key)) return state;
            const {[key]: _, ...remainingCache} = state.runtimeCache;
            return {...state, runtimeCache: remainingCache};
        }


        default:
            return state;
    }
};


// ==========================================================================
// 3. Plugin Architecture & CoreAPI (Refined API)
// ==========================================================================

/**
 * API provided to plugins. Refined methods.
 */
class CoreAPI {
    // ... constructor similar ...

    // --- State Management ---
    dispatch(action) { /* ... */
    }

    getState() { /* ... */
    } // Returns full state (read-only convention)
    subscribe(listener) { /* ... */
    }

    /**
     * Helper to get a specific note by ID.
     * @returns {CoreNote | null}
     */
    getNoteById(noteId) {
        return this.getState().notes[noteId] || null;
    }

    /**
     * Helper to get the currently selected note.
     * @returns {CoreNote | null}
     */
    getSelectedNote() {
        const state = this.getState();
        return state.uiState.selectedNoteId ? state.notes[state.uiState.selectedNoteId] : null;
    }

    /**
     * Helper to get a System Note by its type.
     * Returns the full note object. Plugins can read content/properties.
     * @param {string} systemType - e.g., 'plugin/nostr/relays'
     * @returns {CoreNote | null}
     */
    getSystemNoteByType(systemType) {
        const state = this.getState();
        const noteId = state.systemNoteIndex[systemType];
        return noteId ? state.notes[noteId] : null;
    }

    /**
     * Helper to get a specific plugin's settings.
     * @param {string} pluginId
     * @returns {any} The settings object for the plugin, or an empty object.
     */
    getPluginSettings(pluginId) {
        return this.getState().settings.plugins[pluginId] || {};
    }

    /**
     * Helper to get a value from the runtime cache.
     * @param {string} key
     * @returns {any | undefined}
     */
    getRuntimeCache(key) {
        return this.getState().runtimeCache[key];
    }

    // --- Event Bus ---
    publishEvent(eventType, payload) { /* ... */
    }

    subscribeToEvent(eventType, handler) { /* ... */
    }

    // --- UI Rendering ---
    // registerUISlot is removed - registration happens via Plugin Definition
    renderEphemeralComponent(component) { /* ... */
    }

    /**
     * Utility to show a standardized global status message.
     */
    showGlobalStatus(message, type = 'info', duration = 5000) {
        this.dispatch({type: 'CORE_SET_GLOBAL_STATUS', payload: {message, type, duration}});
        if (duration > 0) {
            setTimeout(() => this.dispatch({type: 'CORE_CLEAR_GLOBAL_STATUS'}), duration);
        }
    }

    // --- Services & Plugin Interaction ---
    getService(serviceName) { /* ... */
    }

    getPluginAPI(pluginId) { /* ... */
    }

    // --- Utilities ---
    utils = Utils;
}

// --- Refined Plugin Definition Structure (Conceptual) ---
/*
const MyPlugin = {
    id: 'my-plugin-id',
    name: 'My Awesome Plugin',
    version: '1.0.0',
    dependencies: [],

    init: (coreAPI) => { // CoreAPI is ready
        this.coreAPI = coreAPI; // Store for later use if needed
        console.log(`MyPlugin [${this.id}] initialized.`);
        // Setup internal state, subscribe to events/state needed *before* activation
    },

    onActivate: () => { // Plugin is fully registered and active
         console.log(`MyPlugin [${this.id}] activated.`);
         // Start background tasks, listeners, etc.
         const editorService = this.coreAPI.getService('EditorService');
         if (editorService) { /* interact */
}
},

onDeactivate: () => {
    console.log(`MyPlugin [${this.id}] deactivated.`);
    // Cleanup resources, unsubscribe, stop timers.
},

    // --- Capability Registration Methods ---

    // No more extendNoteModel/extendSettingsModel - handled by the plugin's reducer

    registerReducer
:
() => {
    // Return ONE reducer function for this plugin.
    // This function receives the *entire* app state and the action.
    // It's responsible for updating *all* state slices relevant to this plugin
    // (e.g., note.pluginData.myPlugin, pluginRuntimeState.myPlugin, settings.plugins.myPlugin)
    // Use Immer or similar libraries for easier immutable updates.
    return (state, action) => {
        let nextState = state; // Start with current state

        switch (action.type) {
            case 'CORE_ADD_NOTE':
                // Initialize plugin-specific data for the newly added note
                const newNoteId = state.noteOrder[0]; // Assumes core reducer added it to the front
                if (!nextState.notes[newNoteId].pluginData) {
                    nextState = {
                        ...nextState,
                        notes: {...nextState.notes, [newNoteId]: {...nextState.notes[newNoteId], pluginData: {}}}
                    };
                }
                nextState = {
                    ...nextState,
                    notes: {
                        ...nextState.notes,
                        [newNoteId]: {
                            ...nextState.notes[newNoteId],
                            pluginData: {...nextState.notes[newNoteId].pluginData, [this.id]: {initialized: true}}
                        }
                    }
                };
                break;

            case 'MY_PLUGIN_SPECIFIC_ACTION':
                // Update pluginRuntimeState or note pluginData etc.
                nextState = {
                    ...nextState,
                    pluginRuntimeState: {...nextState.pluginRuntimeState, [this.id]: {someValue: action.payload.value}}
                };
                break;

            case 'CORE_UPDATE_NOTE':
                // React if needed, e.g., update internal cache if note content changed
                break;

            case 'CORE_DELETE_NOTE':
                // Clean up plugin runtime state if it was related to the deleted note
                const deletedNoteId = action.payload.noteId;
                if (nextState.pluginRuntimeState[this.id]?.activeThing === deletedNoteId) {
                    nextState = {
                        ...nextState,
                        pluginRuntimeState: {
                            ...nextState.pluginRuntimeState,
                            [this.id]: {...nextState.pluginRuntimeState[this.id], activeThing: null}
                        }
                    };
                }
                break;
            // Handle CORE_SET_PLUGIN_SETTING if this plugin defines settings this way (alternative to dedicated actions)
        }

        // IMPORTANT: Return the potentially modified state
        return nextState;
    };
},

    registerMiddleware
:
() => { /* ... similar ... */
},
    registerUISlots
:
() => { /* ... similar ... */
},
    providesServices
:
() => {
    // Example: Editor Plugin
    // return {
    //     'EditorService': {
    //         getContent: () => { /*...*/ },
    //         getSelection: () => { /*...*/ },
    //         applyDecoration: (range, style) => { /*...*/ },
    //         // etc.
    //     }
    // }
},
    getAPI
:
() => { /* ... similar ... */
}
}
;
*/

// ==========================================================================
// 4. Application Initialization Flow (Refined)
// ==========================================================================

async function main() {
    console.log("Initializing Reality Notebook v10.1 Core...");

    // 1. Initialize Core Services
    const eventBus = new EventBus();
    // Pass the single coreReducer function to StateManager
    const stateManager = new StateManager(initialAppState, coreReducer);
    const uiRenderer = new UIRenderer(stateManager, 'app');
    const pluginManager = new PluginManager(stateManager, uiRenderer, eventBus);
    const persistenceService = new PersistenceService(stateManager);

    // Make core API accessible globally for debugging (optional)
    window.realityNotebookCore = pluginManager._coreAPI;
    window._getState = stateManager.getState.bind(stateManager); // Easier debug access

    // 2. Load Initial State
    const loadedState = await persistenceService.loadState();
    stateManager.dispatch({type: 'CORE_STATE_LOADED', payload: {loadedState}});

    // Add basic theme application from loaded state
    document.documentElement.setAttribute('data-theme', stateManager.getState().settings.core.theme);


    // 3. Register Plugins (Bundled or loaded)
    // Example: Register actual plugin objects/definitions here
    // pluginManager.registerPlugin(PropertiesPlugin);
    // pluginManager.registerPlugin(EditorPlugin);
    // pluginManager.registerPlugin(NostrPlugin);
    // ...

    // 4. Activate Plugins
    pluginManager.activatePlugins(); // Handles init, registration, activation hooks

    // 5. Initial Render (Now includes plugin UI registered during activation)
    uiRenderer.renderApp();

    console.log("Reality Notebook Core Initialized and Rendered.");

    // Post-initialization tasks? e.g., check for onboarding needed by dispatching an action
    // stateManager.dispatch({ type: 'APP_INITIALIZED_CHECK_ONBOARDING' });
}

// Start the application
document.addEventListener('DOMContentLoaded', main);

```

**Key Refinements in v10.1:**

1. **Plugin Reducer Strategy:** Plugins now register *one* main reducer function responsible for handling *all* relevant
   actions and updating *all* parts of the state they manage (their `pluginRuntimeState`, `note.pluginData`,
   `settings.plugins`, reacting to core actions, etc.). This simplifies registration and gives plugins full control over
   their state domains. Core reducers focus solely on core state slices.
2. **System Notes:** Added `AppState.systemNoteIndex` and `CoreAPI.getSystemNoteByType` to provide a standard way for
   plugins (like Ontology, Nostr, LLM) to access configuration stored in notes with a specific `systemType`. The core
   reducers manage this index when notes with `systemType` are added, updated, or deleted.
3. **Editor Service:** Explicitly stated that the `EditorPlugin` should provide an `EditorService` for other plugins (
   like `SemanticParser`) to interact with it programmatically.
4. **Plugin Runtime State:** Added `AppState.pluginRuntimeState` as a dedicated, non-persisted slice for plugins to
   manage complex transient state (like the AI Interview chat).
5. **State Filtering:** `PersistenceService.filterStateForSaving` now explicitly excludes `uiState` and
   `pluginRuntimeState`.
6. **Robust Initialization & Error Handling:** Added more detailed status tracking and error handling concepts in
   `PluginManager` and `UIRenderer`.
7. **API Refinements:** Added helper methods to `CoreAPI` (`getNoteById`, `getSelectedNote`, `getSystemNoteByType`,
   `getPluginSettings`, `getRuntimeCache`, `showGlobalStatus`) for convenience and better encapsulation. Removed
   `registerUISlot` from `CoreAPI` as it's handled via the plugin definition.
8. **Core State/Reducers:** Refined core state structure (`systemNoteIndex`) and core reducers to handle `systemType`
   correctly and delegate plugin data management entirely to plugin reducers. Added core settings action. Added runtime
   cache actions. Added global status actions.
9. **UI:** Added `SLOT_APP_STATUS_BAR`, core settings trigger button, and refined modal rendering structure. Uses event
   delegation for core listeners.
10. **Sanitization:** Added `Utils.sanitizeHTML` placeholder with a strong warning to use a proper library like
    DOMPurify.
11. **Clarity:** Improved comments and pseudocode structure to better reflect the intended implementation flow.
