"use strict";

import {SLOT_SETTINGS_PANEL_SECTION} from './ui.js'; // Assuming ui.js exports it
import {Utils} from './util.js'; // Import Utils

// Default ontology - Enhanced Structure
const ONTOLOGY = {
    // Property Definitions (NEW): Define expected properties, their types, constraints, and relationships
    properties: {
        "dueDate": {
            type: "date", // Expected data type
            description: "The date when a task or item is due.",
            uiHint: "date", // Link to uiHints key
            validation: { required: false } // Example constraint
        },
        "priority": {
            type: "number",
            description: "Numeric priority level (e.g., 1-10).",
            uiHint: "priority",
            validation: { required: false, min: 1, max: 10 }
        },
        "status": {
            type: "text", // Could be 'enum' if we add support
            description: "Current status of a task or item.",
            uiHint: "status",
            validation: { required: false, allowedValues: ["Todo", "In Progress", "Done", "Blocked"] }
        },
        "assignee": {
            type: "reference", // Link to another entity (e.g., contact note)
            description: "Person responsible for the task.",
            uiHint: "assignee",
            validation: { required: false, referenceType: "contact" } // Specify linked type
        },
        "project": {
            type: "reference",
            description: "Associated project.",
            uiHint: "project",
            validation: { required: false, referenceType: "project" }
        },
        "tags": {
            type: "list", // List of strings
            description: "Keywords or labels.",
            uiHint: "tags",
            validation: { required: false, itemType: "text" }
        },
        "location": {
            type: "location", // Specific type for locations
            description: "A physical place or address.",
            uiHint: "location",
            validation: { required: false }
        },
        "url": {
            type: "url",
            description: "A web address.",
            uiHint: "url",
            validation: { required: false }
        }
        // Add more property definitions here...
    },
    // Type Inference Rules (Enhanced): More specific rules
    rules: [
        // Order matters - more specific rules first
        { pattern: "^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})?)?$", type: "date", description: "ISO 8601 Date/DateTime" },
        { pattern: "^(https?|ftp):\\/\\/[^\\s/$.?#].[^\\s]*$", type: "url", description: "Detects URLs" },
        { pattern: "^\\d+$", type: "number", description: "Detects whole numbers" },
        { pattern: "^\\d*\\.\\d+$", type: "number", description: "Detects decimal numbers" },
        { pattern: "^(true|false|yes|no|on|off)$", type: "boolean", caseSensitive: false, description: "Detects common boolean strings" },
        // Add rules for locations, specific formats, etc.
    ],
    // Templates remain the same for now
    templates: [
        {
            name: "Meeting Notes",
            content: "# Meeting Notes\n\n**Date:** {{date}}\n**Attendees:** \n\n## Agenda\n\n## Notes\n\n## Action Items\n\n"
        },
        // Add more templates...
    ],
    // UI Hints (Expanded): Provide icons, colors, input types, options for properties/types
    uiHints: {
        // By Type
        "date": { icon: "📅", color: "#3498db", inputType: "date" },
        "url": { icon: "🔗", color: "#2ecc71", inputType: "url" },
        "number": { icon: "#️⃣", color: "#f39c12", inputType: "number" },
        "boolean": { icon: "✔️", color: "#9b59b6", inputType: "checkbox" },
        "reference": { icon: "📎", color: "#34495e", inputType: "text" }, // Input could be a search/select later
        "list": { icon: "📜", color: "#7f8c8d", inputType: "textarea" }, // Simple input for comma-separated?
        "location": { icon: "📍", color: "#e74c3c", inputType: "text" },
        "text": { icon: "📝", color: "#888", inputType: "text" },
        // By Specific Property Key (overrides type hint if needed)
        "priority": { icon: "⭐", color: "#f1c40f", inputType: "range", min: 1, max: 10, step: 1 }, // Use range slider
        "status": { icon: "📊", color: "#1abc9c", inputType: "select", options: ["Todo", "In Progress", "Done", "Blocked"] }, // Use dropdown
        "assignee": { icon: "👤", color: "#e67e22", inputType: "text" }, // Could link to contacts later
        "project": { icon: "📁", color: "#2980b9", inputType: "text" }, // Could link to project notes later
        "tags": { icon: "#️⃣", color: "#7f8c8d", inputType: "text" }, // Input for comma-separated tags
        // Default fallback
        "default": { icon: "❓", color: "#ccc", inputType: "text" }
    },
    // Keywords (Expanded): Include common properties derived from definitions
    keywords: {
        categories: ["Work", "Personal", "Research", "Ideas"],
        tags: ["important", "urgent", "review"],
        // commonProperties can be dynamically generated or kept for quick access
        // commonProperties: ["dueDate", "assignee", "status", "project", "priority", "tags", "location", "url"] // Updated list
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

        this.coreAPI.subscribe((newState, oldState) => {
            const newConfigNote = this.coreAPI.getSystemNoteByType('config/ontology');
            const oldConfigNote = oldState.notes[this._configNoteId];

            if (newConfigNote && (!this._configNoteId || newConfigNote.id !== this._configNoteId || newConfigNote.updatedAt !== oldConfigNote?.updatedAt)) {
                if (newConfigNote.updatedAt !== this._configNoteLastUpdate) {
                    console.log(`OntologyPlugin: Config note changed (ID: ${newConfigNote.id}, Updated: ${newConfigNote.updatedAt}), reloading...`);
                    this._loadOntology(newConfigNote);
                }
            } else if (!newConfigNote && this._configNoteId) {
                console.log("OntologyPlugin: Config note deleted, clearing ontology.");
                if (this._ontologyData !== null) {
                    this._ontologyData = null;
                    this._configNoteId = null;
                    this._configNoteLastUpdate = 0;
                    this.coreAPI.publishEvent('ONTOLOGY_UNLOADED', {});
                    console.log("OntologyPlugin: Ontology data cleared.");
                }
            }
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
                console.error("OntologyPlugin: Failed to parse config note content.", {
                    noteId: configNote?.id,
                    error: e
                });
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
    providesServices: function () { // Use function() to ensure 'this' refers to the plugin instance
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
                    // 1. Check property definition first if nameHint is provided
                    if (nameHint && this._ontologyData?.properties?.[nameHint]?.type) {
                        return this._ontologyData.properties[nameHint].type;
                    }

                    // 2. Check explicit rules
                    const rules = this._ontologyData?.rules || [];
                    if (typeof value === 'string') {
                        for (const rule of rules) {
                            try {
                                const regex = new RegExp(rule.pattern, rule.caseSensitive ? '' : 'i');
                                if (regex.test(value)) {
                                    return rule.type || 'text'; // Return defined type or default
                                }
                            } catch (e) {
                                console.warn(`OntologyService: Invalid regex pattern in rule: ${rule.pattern}`, e);
                            }
                        }
                    }

                    // 3. Basic typeof checks as fallback
                    if (typeof value === 'number') return 'number';
                    if (typeof value === 'boolean') return 'boolean';

                    // 4. Default fallback
                    return 'text';
                },

                /**
                 * (Placeholder) Gets UI hints (like icons, colors) for a specific property or type based on ontology rules.
                 * @param {string} property - The name of the property or semantic type.
                 * @returns {object} An object with UI hints (e.g., { icon: ' M ', color: '#ccc', inputType: 'text' }).
                 */
                getUIHints: (propertyKey) => {
                    const defaultHint = this._ontologyData?.uiHints?.default || { icon: '❓', color: '#ccc', inputType: 'text' };
                    if (!propertyKey || !this._ontologyData) return defaultHint;

                    // 1. Check for hint specific to the property key
                    const keyHint = this._ontologyData.uiHints?.[propertyKey] || this._ontologyData.uiHints?.[propertyKey.toLowerCase()];
                    if (keyHint) return { ...defaultHint, ...keyHint }; // Merge with default

                    // 2. Check for hint based on the property's defined type
                    const propertyDefinition = this._ontologyData.properties?.[propertyKey] || this._ontologyData.properties?.[propertyKey.toLowerCase()];
                    const type = propertyDefinition?.type;
                    if (type) {
                        const typeHint = this._ontologyData.uiHints?.[type];
                        if (typeHint) return { ...defaultHint, ...typeHint }; // Merge with default
                    }

                    // 3. Fallback to default
                    return defaultHint;
                },


                /**
                 * Retrieves the entire loaded ontology data structure. Use with caution.
                 * Prefer specific getters like getHints() or getTemplates().
                 * @returns {object | null} The raw ontology data object, or null if not loaded.
                 */
                getRawData: () => this._ontologyData,

                /** Added for Enhancement #4 - Now dynamically gets keys from property definitions */
                getCommonProperties: () => Object.keys(this._ontologyData?.properties || {}),

                /** Get validation rules for a property */
                getValidationRules: (propertyKey) => {
                    if (!propertyKey || !this._ontologyData?.properties) return null;
                    return this._ontologyData.properties[propertyKey]?.validation || this._ontologyData.properties[propertyKey.toLowerCase()]?.validation || null;
                }
            }
        };
    },

    // --- UI Rendering ---

    registerUISlots: function () {
        return {
            [SLOT_SETTINGS_PANEL_SECTION]: (props) => {
                const { state, dispatch, html } = props;
                const configNote = this.coreAPI.getSystemNoteByType('config/ontology');
                const noteId = configNote?.id;
                const currentOntologyData = this._ontologyData || ONTOLOGY; // Use loaded data or default

                if (!noteId) {
                    // Render button to create the config note
                    const ontology_str = JSON.stringify(ONTOLOGY, null, 2);
                    return html`
                        <div class="settings-section ontology-settings">
                            <h4>${this.name}</h4>
                            <p>Configure semantic types, templates, keywords, and hints.</p>
                            <p>Configuration note not found.</p>
                            <button @click=${() => this._handleCreateOntologyNote(dispatch, ontology_str)}>
                                Create Ontology Config Note
                            </button>
                        </div>
                    `;
                } else {
                    // Render the editor UI
                    return html`
                        <div class="settings-section ontology-settings">
                            <h4>${this.name} Editor</h4>
                            <p>Configuration stored in System Note: ${noteId}</p>
                            <p class="settings-hint">Last loaded update: ${this._configNoteLastUpdate ? new Date(this._configNoteLastUpdate).toLocaleString() : 'Never'}</p>
                            ${this._renderOntologyEditor(currentOntologyData, noteId, dispatch, html)}
                            <style>${this._getEditorCSS()}</style>
                        </div>
                    `;
                }
            }
        }
    },

    // --- UI Helper Methods ---

    _handleCreateOntologyNote(dispatch, ontologyString) {
        dispatch({
            type: 'CORE_ADD_NOTE',
            payload: {
                name: 'Ontology Configuration',
                systemType: 'config/ontology',
                content: ontologyString
            }
        });
        this.coreAPI.showGlobalStatus("Ontology config note created. Edit it to customize.", "info", 5000);
    },

    _renderOntologyEditor(ontologyData, noteId, dispatch, html) {
        // Helper to render a section (Properties, Rules, Hints, Templates)
        const renderSection = (title, key, items, renderItemFn, addItemFn) => html`
            <details class="ontology-section">
                <summary>${title} (${Object.keys(items || {}).length})</summary>
                <div class="ontology-items">
                    ${Object.entries(items || {}).map(([itemKey, itemValue]) => renderItemFn(itemKey, itemValue))}
                </div>
                <button class="ontology-add-button" @click=${() => addItemFn(key)}>+ Add ${title.slice(0, -1)}</button>
            </details>
        `;

        // Render individual property definition
        const renderPropertyItem = (propKey, propValue) => html`
            <div class="ontology-item property-item" data-key=${propKey} data-section="properties">
                <strong class="ontology-item-key">${propKey}</strong>
                <button class="ontology-delete-button" title="Delete Property" @click=${(e) => this._handleDeleteOntologyItem(e, ontologyData, noteId, dispatch)}>×</button>
                <div class="ontology-item-fields">
                    <label>Type:</label><input type="text" .value=${propValue.type || 'text'} @input=${(e) => this._handleOntologyChange(e, 'type', ontologyData, noteId, dispatch)}>
                    <label>Description:</label><input type="text" .value=${propValue.description || ''} @input=${(e) => this._handleOntologyChange(e, 'description', ontologyData, noteId, dispatch)}>
                    <label>UI Hint Key:</label><input type="text" .value=${propValue.uiHint || ''} @input=${(e) => this._handleOntologyChange(e, 'uiHint', ontologyData, noteId, dispatch)}>
                    <label>Validation (JSON):</label><textarea rows="2" .value=${JSON.stringify(propValue.validation || {}, null, 2)} @input=${(e) => this._handleOntologyChange(e, 'validation', ontologyData, noteId, dispatch)}></textarea>
                </div>
            </div>
        `;

        // Render individual rule
        const renderRuleItem = (index, ruleValue) => html`
            <div class="ontology-item rule-item" data-key=${index} data-section="rules">
                <strong class="ontology-item-key">Rule ${parseInt(index, 10) + 1}</strong>
                <button class="ontology-delete-button" title="Delete Rule" @click=${(e) => this._handleDeleteOntologyItem(e, ontologyData, noteId, dispatch)}>×</button>
                <div class="ontology-item-fields">
                    <label>Pattern (Regex):</label><input type="text" .value=${ruleValue.pattern || ''} @input=${(e) => this._handleOntologyChange(e, 'pattern', ontologyData, noteId, dispatch)}>
                    <label>Type:</label><input type="text" .value=${ruleValue.type || 'text'} @input=${(e) => this._handleOntologyChange(e, 'type', ontologyData, noteId, dispatch)}>
                    <label>Description:</label><input type="text" .value=${ruleValue.description || ''} @input=${(e) => this._handleOntologyChange(e, 'description', ontologyData, noteId, dispatch)}>
                    <label>Case Sensitive:</label><input type="checkbox" .checked=${!!ruleValue.caseSensitive} @change=${(e) => this._handleOntologyChange(e, 'caseSensitive', ontologyData, noteId, dispatch)}>
                </div>
            </div>
        `;

        // Render individual UI Hint
        const renderHintItem = (hintKey, hintValue) => html`
            <div class="ontology-item hint-item" data-key=${hintKey} data-section="uiHints">
                <strong class="ontology-item-key">${hintKey}</strong>
                <button class="ontology-delete-button" title="Delete Hint" @click=${(e) => this._handleDeleteOntologyItem(e, ontologyData, noteId, dispatch)}>×</button>
                <div class="ontology-item-fields">
                    <label>Icon:</label><input type="text" .value=${hintValue.icon || ''} @input=${(e) => this._handleOntologyChange(e, 'icon', ontologyData, noteId, dispatch)}>
                    <label>Color:</label><input type="color" .value=${hintValue.color || '#cccccc'} @input=${(e) => this._handleOntologyChange(e, 'color', ontologyData, noteId, dispatch)}>
                    <label>Input Type:</label><input type="text" .value=${hintValue.inputType || 'text'} @input=${(e) => this._handleOntologyChange(e, 'inputType', ontologyData, noteId, dispatch)}>
                    <label>Options (JSON Array):</label><input type="text" .value=${JSON.stringify(hintValue.options || [])} @input=${(e) => this._handleOntologyChange(e, 'options', ontologyData, noteId, dispatch)}>
                    <label>Min:</label><input type="number" .value=${hintValue.min ?? ''} @input=${(e) => this._handleOntologyChange(e, 'min', ontologyData, noteId, dispatch)}>
                    <label>Max:</label><input type="number" .value=${hintValue.max ?? ''} @input=${(e) => this._handleOntologyChange(e, 'max', ontologyData, noteId, dispatch)}>
                    <label>Step:</label><input type="number" .value=${hintValue.step ?? ''} @input=${(e) => this._handleOntologyChange(e, 'step', ontologyData, noteId, dispatch)}>
                </div>
            </div>
        `;

        // Render individual template
        const renderTemplateItem = (index, templateValue) => html`
            <div class="ontology-item template-item" data-key=${index} data-section="templates">
                <strong class="ontology-item-key">Template ${parseInt(index, 10) + 1}</strong>
                <button class="ontology-delete-button" title="Delete Template" @click=${(e) => this._handleDeleteOntologyItem(e, ontologyData, noteId, dispatch)}>×</button>
                <div class="ontology-item-fields">
                    <label>Name:</label><input type="text" .value=${templateValue.name || ''} @input=${(e) => this._handleOntologyChange(e, 'name', ontologyData, noteId, dispatch)}>
                    <label>Content:</label><textarea rows="4" .value=${templateValue.content || ''} @input=${(e) => this._handleOntologyChange(e, 'content', ontologyData, noteId, dispatch)}></textarea>
                </div>
            </div>
        `;

        return html`
            <div class="ontology-editor">
                ${renderSection('Properties', 'properties', ontologyData.properties, renderPropertyItem, this._handleAddOntologyItem.bind(this))}
                ${renderSection('Rules', 'rules', ontologyData.rules, renderRuleItem, this._handleAddOntologyItem.bind(this))}
                ${renderSection('UI Hints', 'uiHints', ontologyData.uiHints, renderHintItem, this._handleAddOntologyItem.bind(this))}
                ${renderSection('Templates', 'templates', ontologyData.templates, renderTemplateItem, this._handleAddOntologyItem.bind(this))}
                <!-- Keywords section could be added similarly -->
            </div>
        `;
    },

    _handleAddOntologyItem(sectionKey, ontologyData, noteId, dispatch) {
        const newItemKey = prompt(`Enter new key for ${sectionKey} (or leave blank for array items):`);
        if (newItemKey === null) return; // User cancelled

        const updatedOntology = { ...ontologyData }; // Shallow copy

        if (Array.isArray(updatedOntology[sectionKey])) {
            updatedOntology[sectionKey] = [...updatedOntology[sectionKey], {}]; // Add empty object for arrays (rules, templates)
        } else {
            if (!newItemKey || updatedOntology[sectionKey]?.[newItemKey]) {
                alert(`Invalid or duplicate key: "${newItemKey}"`);
                return;
            }
            updatedOntology[sectionKey] = { ...(updatedOntology[sectionKey] || {}), [newItemKey]: {} }; // Add empty object for maps (properties, uiHints)
        }

        this._handleSaveOntology(updatedOntology, noteId, dispatch);
    },

    _handleDeleteOntologyItem(event, ontologyData, noteId, dispatch) {
        const itemElement = event.target.closest('.ontology-item');
        const sectionKey = itemElement.dataset.section;
        const itemKey = itemElement.dataset.key;

        if (!confirm(`Are you sure you want to delete this item from ${sectionKey}?`)) return;

        const updatedOntology = { ...ontologyData }; // Shallow copy

        if (Array.isArray(updatedOntology[sectionKey])) {
            const index = parseInt(itemKey, 10);
            updatedOntology[sectionKey] = updatedOntology[sectionKey].filter((_, i) => i !== index);
        } else {
            updatedOntology[sectionKey] = { ...(updatedOntology[sectionKey] || {}) }; // Ensure object exists
            delete updatedOntology[sectionKey][itemKey];
        }

        this._handleSaveOntology(updatedOntology, noteId, dispatch);
    },

    _handleOntologyChange(event, fieldKey, ontologyData, noteId, dispatch) {
        const input = event.target;
        const itemElement = input.closest('.ontology-item');
        const sectionKey = itemElement.dataset.section;
        const itemKey = itemElement.dataset.key; // This is the key for maps, index for arrays

        let value = input.type === 'checkbox' ? input.checked : input.value;

        // Attempt to parse JSON for specific fields
        if (['validation', 'options'].includes(fieldKey)) {
            try {
                value = JSON.parse(value);
            } catch (e) {
                console.warn(`Invalid JSON for ${sectionKey}[${itemKey}].${fieldKey}:`, value);
                input.style.borderColor = 'red'; // Indicate error
                return; // Don't save invalid JSON
            }
            input.style.borderColor = ''; // Clear error indicator
        }
        // Convert number fields
        if (input.type === 'number') {
            value = value === '' ? null : Number(value);
        }


        // Use Immer-like update pattern (manual for now)
        const updatedOntology = JSON.parse(JSON.stringify(ontologyData)); // Deep copy for safety

        try {
            if (Array.isArray(updatedOntology[sectionKey])) {
                const index = parseInt(itemKey, 10);
                if (updatedOntology[sectionKey][index]) {
                    updatedOntology[sectionKey][index][fieldKey] = value;
                }
            } else {
                if (updatedOntology[sectionKey]?.[itemKey]) {
                    updatedOntology[sectionKey][itemKey][fieldKey] = value;
                }
            }
        } catch (e) {
            console.error("Error updating ontology structure:", e);
            return; // Don't save if structure is wrong
        }


        // Debounce saving
        this._debouncedSaveOntology(updatedOntology, noteId, dispatch);
    },

    // Debounced save function
    _debouncedSaveOntology: Utils.debounce(function(updatedOntology, noteId, dispatch) {
        this._handleSaveOntology(updatedOntology, noteId, dispatch);
    }, 1500), // Debounce time in ms

    _handleSaveOntology(updatedOntology, noteId, dispatch) {
        try {
            const ontologyString = JSON.stringify(updatedOntology, null, 2);
            dispatch({
                type: 'CORE_UPDATE_NOTE',
                payload: {
                    noteId: noteId,
                    changes: { content: ontologyString }
                }
            });
            // No need to manually update this._ontologyData, the subscription will handle it.
            this.coreAPI.showGlobalStatus("Ontology saved.", "success", 1500);
        } catch (e) {
            console.error("Failed to stringify or save ontology:", e);
            this.coreAPI.showGlobalStatus("Error saving ontology.", "error", 5000);
        }
    },

    _getEditorCSS() {
        return `
            .ontology-settings h4 { margin-bottom: 0.5em; }
            .ontology-editor { display: flex; flex-direction: column; gap: 1em; }
            .ontology-section { border: 1px solid var(--vscode-settings-headerBorder); border-radius: 4px; }
            .ontology-section summary { padding: 0.5em; cursor: pointer; background-color: var(--vscode-sideBar-background); }
            .ontology-section[open] summary { border-bottom: 1px solid var(--vscode-settings-headerBorder); }
            .ontology-items { padding: 0.5em 1em 1em 1em; display: flex; flex-direction: column; gap: 1em; max-height: 400px; overflow-y: auto; }
            .ontology-item { border: 1px solid var(--vscode-input-border, #ccc); border-radius: 3px; padding: 0.5em; position: relative; }
            .ontology-item-key { font-weight: bold; display: block; margin-bottom: 0.5em; }
            .ontology-item-fields { display: grid; grid-template-columns: auto 1fr; gap: 0.5em 0.8em; align-items: center; }
            .ontology-item-fields label { grid-column: 1; text-align: right; font-size: 0.9em; color: var(--vscode-descriptionForeground); }
            .ontology-item-fields input[type="text"],
            .ontology-item-fields input[type="number"],
            .ontology-item-fields input[type="url"],
            .ontology-item-fields textarea {
                grid-column: 2;
                width: 100%;
                background-color: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                border: 1px solid var(--vscode-input-border);
                padding: 2px 4px;
                border-radius: 2px;
                font-family: inherit;
                font-size: 0.95em;
            }
             .ontology-item-fields input[type="color"] {
                grid-column: 2;
                padding: 0; border: none; height: 24px; width: 50px;
             }
             .ontology-item-fields input[type="checkbox"] {
                grid-column: 2; justify-self: start;
             }
            .ontology-item-fields textarea { resize: vertical; min-height: 40px; font-family: monospace; }
            .ontology-add-button { margin: 0.5em 1em 1em 1em; }
            .ontology-delete-button {
                position: absolute; top: 2px; right: 2px;
                background: none; border: none; color: var(--vscode-foreground);
                cursor: pointer; font-size: 1.2em; padding: 0 4px; line-height: 1;
            }
            .ontology-delete-button:hover { color: var(--vscode-errorForeground); }
            .settings-hint { font-size: 0.9em; color: var(--vscode-descriptionForeground); margin-top: 0.2em; display: block; }
        `;
    }

    // No primary reducer needed as state (_ontologyData) is managed internally
    // based on external note changes detected via subscription. The editor directly
    // dispatches CORE_UPDATE_NOTE to save changes.
};
