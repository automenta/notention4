"use strict";

import { SLOT_SETTINGS_PANEL_SECTION } from './ui.js'; // Assuming ui.js exports it

// Default ontology
const ONTOLOGY = {
    hints: {
        "exampleHint": { description: "An example hint definition" }
    },
    rules: [
        { pattern: "^\\d+$", type: "integer", description: "Detects whole numbers" }
    ],
    templates: [
        { name: "Meeting Notes", content: "# Meeting Notes\n\n**Date:** {{date}}\n**Attendees:** \n\n## Agenda\n\n## Notes\n\n## Action Items\n\n" }
    ],
    uiHints: {
        "date": { icon: "📅", color: "#3498db" },
        "url": { icon: "🔗", color: "#2ecc71" }
    },
    keywords: {
        categories: ["Work", "Personal", "Research", "Ideas"],
        tags: ["important", "urgent", "review"]
    }
};

export const OntologyPlugin = {
    id: 'ontology',
    name: 'Ontology Manager',
    description: 'Manages shared semantic definitions like types, hints, templates, and keywords loaded from a configuration note.',
    version: '1.0.0',
    dependencies: [], // No explicit plugin dependencies for core functionality

    _ontologyData: null, // Internal cache for parsed ontology definitions
    _configNoteId: null, // ID of the 'config/ontology' note
    _configNoteLastUpdate: 0, // Timestamp of the last known update to avoid unnecessary reloads
    coreAPI: null, // Reference to Core API

    /**
     * Initializes the plugin, loads initial ontology, and subscribes to state changes.
     * @param {CoreAPI} coreAPI - The Core API instance.
     */
    init(coreAPI) {
        this.coreAPI = coreAPI;
        console.log("OntologyPlugin: Initializing...");
        this._loadOntology(); // Attempt initial load

        // Subscribe to state changes to detect updates to the config note
        this.coreAPI.subscribe((newState, oldState) => {
            const newConfigNote = this.coreAPI.getSystemNoteByType('config/ontology');
            const oldConfigNote = oldState.notes[this._configNoteId];

            // Condition 1: Note exists now, didn't before, or ID changed (shouldn't happen often), or timestamp changed
            if (newConfigNote && (!this._configNoteId || newConfigNote.id !== this._configNoteId || newConfigNote.updatedAt !== oldConfigNote?.updatedAt)) {
                if (newConfigNote.updatedAt !== this._configNoteLastUpdate) {
                    console.log(`OntologyPlugin: Config note changed (ID: ${newConfigNote.id}, Updated: ${newConfigNote.updatedAt}), reloading...`);
                    this._loadOntology(newConfigNote);
                }
                // Condition 2: Note existed before, but doesn't now
            } else if (!newConfigNote && this._configNoteId) {
                console.log("OntologyPlugin: Config note deleted, clearing ontology.");
                if (this._ontologyData !== null) { // Only publish/clear if data existed
                    this._ontologyData = null;
                    this._configNoteId = null;
                    this._configNoteLastUpdate = 0;
                    this.coreAPI.publishEvent('ONTOLOGY_UNLOADED', {}); // Notify others data is gone
                    console.log("OntologyPlugin: Ontology data cleared.");
                }
            }
            // Note: If the note content is merely saved without changing updatedAt, this won't trigger a reload.
            // This relies on the core correctly updating the timestamp on relevant changes.
        });
        console.log("OntologyPlugin: Initialized and subscribed to state changes.");
    },

    /**
     * Loads or reloads the ontology data from the 'config/ontology' system note.
     * Publishes 'ONTOLOGY_LOADED' on success or clears data on failure/absence.
     * @param {CoreNote | null} note - Optional pre-fetched note object.
     * @private
     */
    _loadOntology(note = null) {
        const configNote = note || this.coreAPI.getSystemNoteByType('config/ontology');

        if (configNote && configNote.content) {
            // Check if we already loaded this version
            if (configNote.id === this._configNoteId && configNote.updatedAt === this._configNoteLastUpdate) {
                // console.log("OntologyPlugin: Skipping reload, note unchanged.");
                return;
            }

            try {
                // Assume content is JSON. Could add YAML support later using a library.
                const parsedData = JSON.parse(configNote.content);
                // Basic validation (ensure it's an object)
                if (typeof parsedData !== 'object' || parsedData === null) {
                    throw new Error("Parsed content is not a valid object.");
                }

                this._ontologyData = parsedData;
                this._configNoteId = configNote.id;
                this._configNoteLastUpdate = configNote.updatedAt; // Store the timestamp
                console.log("OntologyPlugin: Ontology data loaded/reloaded successfully.");
                // Provide defaults for core structures if missing
                this._ontologyData.hints = this._ontologyData.hints || {};
                this._ontologyData.rules = this._ontologyData.rules || [];
                this._ontologyData.templates = this._ontologyData.templates || [];
                this._ontologyData.uiHints = this._ontologyData.uiHints || {};
                this._ontologyData.keywords = this._ontologyData.keywords || {};
                // Publish event *after* successful load and processing
                this.coreAPI.publishEvent('ONTOLOGY_LOADED', this._ontologyData);

            } catch (e) {
                console.error("OntologyPlugin: Failed to parse config note content.", { noteId: configNote?.id, error: e });
                this.coreAPI.showGlobalStatus(`Error loading ontology: ${e.message}`, "error", 10000);
                // Reset data on error to prevent using stale/corrupt data
                if (this._ontologyData !== null) {
                    this._ontologyData = null;
                    this._configNoteId = configNote?.id || null; // Keep ID to track the problematic note
                    this._configNoteLastUpdate = configNote?.updatedAt || 0;
                    this.coreAPI.publishEvent('ONTOLOGY_UNLOADED', {}); // Notify unloaded state
                }
            }
        } else {
            // Config note not found or has no content
            if (this._ontologyData !== null || this._configNoteId !== null) {
                console.log("OntologyPlugin: No config note found or content empty. Clearing ontology data.");
                this._ontologyData = null; // Reset to default empty state
                this._configNoteId = null;
                this._configNoteLastUpdate = 0;
                this.coreAPI.publishEvent('ONTOLOGY_UNLOADED', {}); // Notify unloaded state
            } else {
                // console.log("OntologyPlugin: No config note found, ontology remains empty.");
            }
        }
    },

    /**
     * Provides the OntologyService to other plugins.
     * @returns {object} An object containing the service definition.
     */
    providesServices: function() { // Use function() to ensure 'this' refers to the plugin instance
        return {
            'OntologyService': {
                /**
                 * Gets all defined type hints.
                 * @returns {object} A map of hint names to their definitions. Returns empty object if unavailable.
                 */
                getHints: () => this._ontologyData?.hints || {},

                /**
                 * Gets all defined templates.
                 * @returns {Array<object>} An array of template objects. Returns empty array if unavailable.
                 */
                getTemplates: () => this._ontologyData?.templates || [],

                /**
                 * Gets all defined keywords or categories.
                 * @returns {object} A map/structure of keywords. Returns empty object if unavailable.
                 */
                getKeywords: () => this._ontologyData?.keywords || {},

                /**
                 * (Placeholder) Infers the semantic type of a value based on ontology rules.
                 * @param {*} value - The value to infer the type for.
                 * @param {string} [nameHint] - An optional hint from the property name.
                 * @returns {string} The inferred type name (e.g., 'text', 'number', 'date', 'url'). Defaults to 'text'.
                 */
                inferType: (value, nameHint) => {
                    // TODO: Implement actual inference logic using this._ontologyData?.rules
                    // Example basic checks:
                    if (typeof value === 'number') return 'number';
                    if (typeof value === 'boolean') return 'boolean';
                    if (typeof value === 'string') {
                        if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/.test(value)) return 'date';
                        if (/^https?:\/\/\S+$/.test(value)) return 'url';
                        // Could add more regex or rule-based checks here based on this._ontologyData.rules
                    }
                    return 'text'; // Default fallback
                },

                /**
                 * (Placeholder) Gets UI hints (like icons, colors) for a specific property or type based on ontology rules.
                 * @param {string} property - The name of the property or semantic type.
                 * @returns {object} An object with UI hints (e.g., { icon: ' M ', color: '#ccc' }).
                 */
                getUIHints: (propertyOrType) => {
                    // TODO: Implement logic using this._ontologyData?.uiHints
                    // Example: Look up propertyOrType in this._ontologyData.uiHints
                    const defaultHints = { icon: '📝', color: '#888' }; // Default icon and color
                    return this._ontologyData?.uiHints?.[propertyOrType] || defaultHints;
                },

                /**
                 * Retrieves the entire loaded ontology data structure. Use with caution.
                 * Prefer specific getters like getHints() or getTemplates().
                 * @returns {object | null} The raw ontology data object, or null if not loaded.
                 */
                getRawData: () => this._ontologyData,
            }
        };
    },

    /**
     * Registers UI components for specific slots.
     * @returns {object} A map of slot names to render functions.
     */
    registerUISlots: function() { // Use function() to ensure 'this' refers to the plugin instance
        return {
            [SLOT_SETTINGS_PANEL_SECTION]: (props) => {
                // Render function needs access to coreAPI, likely via props or global scope
                // Using global coreAPI as per the example structure provided
                const configNote = this.coreAPI.getSystemNoteByType('config/ontology');
                const noteId = configNote?.id;

                // Use lit-html if available via props.html, otherwise basic string templating
                const html = props?.html || ((strings, ...values) => strings.map((s, i) => s + (values[i] || '')).join(''));

                if (noteId) {
                    // Button dispatches multiple actions: select the note and close the modal
                    // Note: Direct onclick string is simple but less robust than event listeners
                    return html`
                        <div class="settings-section">
                            <h4>${this.name}</h4>
                            <p>Configure semantic types, templates, and hints.</p>
                            <p>Configuration is stored in the 'config/ontology' system note.</p>
                            <button
                                @click=${() => {
                        this.coreAPI.dispatch({ type: 'CORE_SELECT_NOTE', payload: { noteId: noteId } });
                        this.coreAPI.dispatch({ type: 'CORE_CLOSE_MODAL' });
                    }}>
                                Edit Ontology Config Note
                            </button>
                             <span class="settings-hint"> (ID: ${noteId})</span>
                             <p class="settings-hint">Last loaded update: ${this._configNoteLastUpdate ? new Date(this._configNoteLastUpdate).toLocaleString() : 'Never'}</p>
                        </div>
                    `;
                } else {
                    const ontology_str = JSON.stringify(ONTOLOGY, null, 2); // Pretty print JSON

                    return html`
                        <div class="settings-section">
                            <h4>${this.name}</h4>
                             <p>Configure semantic types, templates, and hints.</p>
                             <p>Configuration note not found.</p>
                            <button
                                @click=${() => {
                        this.coreAPI.dispatch({
                            type: 'CORE_ADD_NOTE',
                            payload: {
                                name: 'Ontology Configuration',
                                systemType: 'config/ontology',
                                content: ontology_str
                            }
                        });
                        // Maybe close modal after adding? Or let user select it?
                        // this.coreAPI.dispatch({ type: 'CORE_CLOSE_MODAL' });
                        this.coreAPI.showGlobalStatus("Ontology config note created. Edit it to customize.", "info", 5000);
                    }}>
                                Create Ontology Config Note
                            </button>
                        </div>
                    `;
                }
            }
        };
    },

    // No primary reducer needed as state (_ontologyData) is managed internally
    // based on external note changes detected via subscription.
};
