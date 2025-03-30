import './parser.css';
import {SLOT_EDITOR_BELOW_CONTENT} from './ui.js';


export const PropertiesPlugin = {
    id: 'properties',
    name: 'Note Properties',
    dependencies: [], // No dependencies for this foundational plugin
    coreAPI: null, // Will be injected by init

    init(coreAPI) {
        this.coreAPI = coreAPI;
        console.log("PropertiesPlugin: Initialized.");
    },

    // registerReducer returns the actual reducer function, capturing 'this' (plugin instance)
    // and coreAPI via the closure.
    registerReducer() {
        const pluginId = this.id;
        const coreAPI = this.coreAPI; // Capture coreAPI for use in the reducer

        // Use Immer's produce for state modifications
        return (draft, action) => {
            switch (action.type) {
                case 'CORE_ADD_NOTE': {
                    // Initialize pluginData for newly added notes
                    // Core reducer adds the note first, so it should exist.
                    // We assume core reducer adds to the *start* of noteOrder.
                    if (draft.noteOrder.length > 0) {
                        const newNoteId = draft.noteOrder[0];
                        const note = draft.notes[newNoteId];
                        if (note?.pluginData?.[pluginId]) return; // Already initialized
                        if (note) {
                            if (!note.pluginData) note.pluginData = {};
                            if (!note.pluginData[pluginId]) {
                                note.pluginData[pluginId] = {properties: []};
                                // console.log(`PropertiesPlugin: Initialized data for new note ${newNoteId}`);
                            }
                        } else {
                            console.warn(`PropertiesPlugin: CORE_ADD_NOTE - Could not find new note with ID ${newNoteId} in draft state.`);
                        }
                    } else {
                        console.warn(`PropertiesPlugin: CORE_ADD_NOTE - noteOrder is empty after adding note?`);
                    }
                    // No return needed when mutating draft directly
                    break;
                }

                case 'PROPERTY_ADD': { // payload: { noteId, propertyData: { key, value, type? } }
                    const {noteId, propertyData} = action.payload;
                    const note = draft.notes[noteId];

                    // Ensure the note and plugin data structure exist
                    if (!note) {
                        console.warn(`PropertiesPlugin: PROPERTY_ADD - Note not found: ${noteId}`);
                        break;
                    }
                    if (!note.pluginData) note.pluginData = {}; // Initialize pluginData if somehow missing
                    if (!note.pluginData[pluginId]) note.pluginData[pluginId] = {properties: []}; // Initialize properties if missing

                    const propsArray = note.pluginData[pluginId].properties;

                    // Basic validation (could be more robust)
                    if (!propertyData || typeof propertyData.key !== 'string' || !propertyData.key.trim()) {
                        console.warn(`PropertiesPlugin: PROPERTY_ADD - Invalid propertyData provided for note ${noteId}`, propertyData);
                        break;
                    }

                    const key = propertyData.key.trim();
                    let value = propertyData.value;
                    // Infer type using OntologyService if not explicitly provided
                    let type = propertyData.type || (this.ontologyService ? this.ontologyService.inferType(value, key) : 'text');

                    // Normalize value based on type
                    value = this._normalizeValue(value, type);

                    const newProp = {
                        id: coreAPI.utils.generateUUID(),
                        key: key,
                        value: value,
                        type: type,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                    };
                    propsArray.push(newProp);
                    note.updatedAt = Date.now(); // Mark note as updated
                    // console.log(`PropertiesPlugin: Added property to note ${noteId}:`, newProp);
                    break;
                }

                case 'PROPERTY_UPDATE': { // payload: { noteId, propertyId, changes: { key?, value?, type? } }
                    const {noteId, propertyId, changes} = action.payload;
                    const note = draft.notes[noteId];
                    if (!note?.pluginData?.[pluginId]?.properties) {
                        console.warn(`PropertiesPlugin: PROPERTY_UPDATE - Note or properties data not found for note ${noteId}`);
                        break;
                    }

                    const propsArray = note.pluginData[pluginId].properties;
                    const propIndex = propsArray.findIndex(p => p.id === propertyId);

                    if (propIndex === -1) {
                        console.warn(`PropertiesPlugin: PROPERTY_UPDATE - Property not found: ${propertyId} on note ${noteId}`);
                        break;
                    }

                    // Apply allowed changes, ensuring key is trimmed if updated
                    const updatedProp = {...propsArray[propIndex]};
                    let hasChanged = false;
                    if (changes.hasOwnProperty('key') && typeof changes.key === 'string' && changes.key.trim() !== updatedProp.key) {
                        updatedProp.key = changes.key.trim();
                        hasChanged = true;
                    }
                    // Determine the final type *before* normalizing the value
                    let finalType = updatedProp.type;
                    if (changes.hasOwnProperty('type') && typeof changes.type === 'string' && changes.type !== updatedProp.type) {
                        finalType = changes.type;
                        updatedProp.type = finalType; // Update the type on the property
                        hasChanged = true;
                    }
                    // Normalize value if it changed, using the potentially updated type
                    if (changes.hasOwnProperty('value') && changes.value !== updatedProp.value) {
                        updatedProp.value = this._normalizeValue(changes.value, finalType);
                        hasChanged = true;
                    }


                    if (hasChanged) {
                        updatedProp.updatedAt = Date.now();
                        propsArray[propIndex] = updatedProp; // Replace the old property object
                        note.updatedAt = Date.now(); // Mark note as updated
                        // console.log(`PropertiesPlugin: Updated property ${propertyId} on note ${noteId}:`, changes);
                    }
                    break;
                }

                case 'PROPERTY_DELETE': { // payload: { noteId, propertyId }
                    const {noteId, propertyId} = action.payload;
                    const note = draft.notes[noteId];
                    const propsArray = note?.pluginData?.[pluginId]?.properties;

                    if (!propsArray) {
                        console.warn(`PropertiesPlugin: PROPERTY_DELETE - Note or properties data not found for note ${noteId}`);
                        break; // Ensure initialized
                    }

                    const initialLength = propsArray.length;
                    const filteredProps = propsArray.filter(p => p.id !== propertyId);

                    if (filteredProps.length !== initialLength) {
                        note.pluginData[pluginId].properties = filteredProps;
                        note.updatedAt = Date.now(); // Mark note as updated only if something was deleted
                        // console.log(`PropertiesPlugin: Deleted property ${propertyId} from note ${noteId}`);
                    } else {
                        // console.warn(`PropertiesPlugin: PROPERTY_DELETE - Property not found to delete: ${propertyId} on note ${noteId}`);
                    }
                    break;
                }

                // Optional: Handle CORE_DELETE_NOTE if this plugin maintains runtime state
                // related to notes that needs explicit cleanup. In this case, properties
                // live within the note state itself, so they are implicitly deleted with the note.
                // case 'CORE_DELETE_NOTE':
                //    // Clean up runtime state if any...
                //    break;
            }
            // No return needed when mutating the draft.
            // If no case matches, Immer automatically returns the original state.
        };
    },

    registerUISlots() {
        const pluginId = this.id;
        const coreAPI = this.coreAPI; // Capture coreAPI for use in the UI renderer

        return {
            [SLOT_EDITOR_BELOW_CONTENT]: (props) => {
                const {state, dispatch, noteId, html} = props;
                const note = state.notes[noteId];
                const propertiesData = note?.pluginData?.[pluginId]?.properties || [];

                // --- Added for Enhancement #2 ---
                const priorityProp = propertiesData.find(p => p.key.toLowerCase() === 'priority');
                const currentPriority = priorityProp ? (parseInt(priorityProp.value, 10) || 5) : 5; // Default 5

                // --- Event Handlers ---

                // Rewritten for Enhancement #4
                const handleAddProperty = () => {
                    const ontologyService = coreAPI.getService('OntologyService');
                    let possibleKeys = ontologyService?.getCommonProperties() || [];
                    if (!possibleKeys.includes('priority')) possibleKeys.push('priority'); // Ensure priority is there
                    // Add keys from hints?
                    // possibleKeys = [...new Set([...possibleKeys, ...Object.keys(ontologyService?.getHints() || {})])];

                    // TODO: Replace prompt with a proper modal/dropdown UI
                    const optionsText = possibleKeys.map((k, i) => {
                        const hints = ontologyService?.getUIHints(k) || {icon: '?'};
                        return `${i + 1}: ${hints.icon} ${k}`;
                    }).join('\n');
                    const choice = prompt(`Select property to add:\n${optionsText}\n\nOr type a custom key:`);

                    let selectedKey = null;
                    const choiceNum = parseInt(choice, 10);
                    if (!isNaN(choiceNum) && possibleKeys[choiceNum - 1]) {
                        selectedKey = possibleKeys[choiceNum - 1];
                    } else if (choice && choice.trim()) { // Treat as custom key
                        selectedKey = choice.trim();
                    }

                    if (selectedKey) {
                        const value = prompt(`Enter value for "${selectedKey}":`);
                        dispatch({
                            type: 'PROPERTY_ADD',
                            payload: {
                                noteId: noteId,
                                propertyData: {key: selectedKey, value: value ?? ''} // Use ?? for null/undefined from prompt
                            }
                        });
                    }
                };

                const handlePropertyClick = (prop) => {
                    // TODO: Replace prompt with a proper modal/popover editor
                    // This editor should use ontology hints for input types (date picker, range slider, etc.)
                    const action = prompt(`Property: ${prop.key}=${prop.value} (Type: ${prop.type})\n\nEnter 'update' or 'delete':`);
                    if (action?.toLowerCase() === 'update') {
                        const newKey = prompt(`Update key (current: ${prop.key}):`, prop.key);
                        const newValue = prompt(`Update value (current: ${prop.value}):`, prop.value);
                        // Optionally prompt for type change?
                        // const newType = prompt(`Update type (current: ${prop.type}):`, prop.type);

                        if (newKey !== null || newValue !== null /* || newType !== null */) {
                            dispatch({
                                type: 'PROPERTY_UPDATE',
                                payload: {
                                    noteId: noteId,
                                    propertyId: prop.id,
                                    changes: {
                                        ...(newKey !== null && { key: newKey }),
                                        ...(newValue !== null && { value: newValue }),
                                        // ...(newType !== null && { type: newType })
                                    }
                                }
                            });
                        }
                    } else if (action?.toLowerCase() === 'delete') {
                        if (confirm(`Are you sure you want to delete property "${prop.key}"?`)) {
                            dispatch({
                                type: 'PROPERTY_DELETE',
                                payload: { noteId: noteId, propertyId: prop.id }
                            });
                        }
                    }
                };

                // --- Added for Enhancement #2 ---
                const handlePriorityChange = coreAPI.utils.debounce((newValue) => {
                    const value = parseInt(newValue, 10) || 5; // Default to 5 if invalid
                    if (priorityProp) { // Update existing
                        dispatch({
                            type: 'PROPERTY_UPDATE',
                            payload: {noteId: noteId, propertyId: priorityProp.id, changes: {value: value}}
                        });
                    } else { // Add new
                        dispatch({
                            type: 'PROPERTY_ADD',
                            payload: {noteId: noteId, propertyData: {key: 'priority', value: value, type: 'number'}}
                        });
                    }
                }, 500); // Debounce slider changes

                // --- Helper for Enhancement #2 ---
                const getPriorityClass = (priorityValue) => {
                    if (priorityValue >= 8) return 'priority-high';
                    if (priorityValue >= 5) return 'priority-medium';
                    return 'priority-low';
                };

                // --- Render Logic ---
                // --- Render Logic ---
                const ontologyService = this.ontologyService; // Get service instance

                return html`
                    <div class="properties-area plugin-section">
                        <h4 class="plugin-section-title">Properties</h4>
                        ${propertiesData.length > 0 ? html`
                            <div class="properties-list">
                                ${propertiesData.map(prop => {
                                    // Get UI hints from OntologyService
                                    const hints = ontologyService?.getUIHints(prop.key) || { icon: '📝', color: '#888' };
                                    const displayValue = this._formatDisplayValue(prop.value, prop.type);
                                    const title = `Click to edit/delete\nType: ${prop.type || 'text'}\nCreated: ${coreAPI.utils.formatDate(prop.createdAt)}\nUpdated: ${coreAPI.utils.formatDate(prop.updatedAt)}`;

                                    return html`
                                    <button class="property-pill ${prop.key.toLowerCase() === 'priority' ? getPriorityClass(parseInt(prop.value, 10) || 5) : ''}"
                                            style="--prop-color: ${hints.color};"
                                            @click=${() => handlePropertyClick(prop)}
                                            title=${title}
                                    >
                                        <span class="property-icon">${hints.icon}</span>
                                        <span class="property-key">${prop.key}:</span>
                                        <span class="property-value">${displayValue}</span>
                                    </button>
                                `})}
                            </div>
                        ` : html`
                            <p class="no-properties-message">No properties defined for this note.</p>
                        `}
                        <button class="add-property-button" @click=${handleAddProperty}>
                            + Add Property...
                        </button>

                        <!-- Added for Enhancement #2 -->
                        <label for="priority-slider-${noteId}"
                               style="margin-left: 15px; font-size: 0.9em;">Priority:</label>
                        <input type="range" id="priority-slider-${noteId}" min="1" max="10" step="1"
                               .value=${currentPriority} @input=${(e) => handlePriorityChange(e.target.value)}
                               style="vertical-align: middle; width: 100px;">
                        <span style="font-size: 0.9em; margin-left: 5px;">(${currentPriority})</span>
                        </button>
                    </div>
                `;
            }
        };
    },

    // Optional: Expose helper functions via the plugin's API
    getAPI() {
        const pluginId = this.id;
        return {
            getPropertiesForNote: (noteId) => {
                const state = this.coreAPI.getState();
                return state.notes[noteId]?.pluginData?.[pluginId]?.properties || [];
            },
            // Could add functions like findPropertyByKey(noteId, key), etc.
        };
    },

    // --- Internal Helper Methods ---

    /**
     * Normalizes a value based on its intended semantic type.
     * @param {*} value - The raw value.
     * @param {string} type - The target semantic type (e.g., 'number', 'boolean', 'date').
     * @returns {*} The normalized value.
     * @private
     */
    _normalizeValue(value, type) {
        if (value === null || value === undefined) return value; // Keep null/undefined as is

        switch (type) {
            case 'number':
                const num = Number(value);
                return isNaN(num) ? value : num; // Keep original if not a valid number
            case 'boolean':
                if (typeof value === 'boolean') return value;
                const lowerVal = String(value).toLowerCase();
                if (['true', 'yes', '1', 'on'].includes(lowerVal)) return true;
                if (['false', 'no', '0', 'off'].includes(lowerVal)) return false;
                return Boolean(value); // Fallback to standard JS boolean conversion
            case 'date':
                // Attempt to parse and potentially reformat, but be cautious
                // For now, just return the value. More robust parsing needed.
                // Example: Could try new Date(value) and if valid, return ISO string?
                return value;
            case 'list':
                // If it's a string, try splitting by comma? Very basic.
                if (typeof value === 'string') {
                    return value.split(',').map(s => s.trim()).filter(s => s);
                }
                // If already an array, keep it. Otherwise, wrap it?
                return Array.isArray(value) ? value : [value];
            // Add normalization for 'url', 'location', 'reference' if needed
            case 'text':
            default:
                // Ensure it's a string
                return String(value);
        }
    },

    /**
     * Formats a value for display in the UI based on its type.
     * @param {*} value - The normalized value.
     * @param {string} type - The semantic type.
     * @returns {string} The formatted string representation.
     * @private
     */
    _formatDisplayValue(value, type) {
        if (value === null || value === undefined) return '';

        switch (type) {
            case 'boolean':
                return value ? 'Yes' : 'No'; // Or use icons ✔️ / ❌ ?
            case 'date':
                // Use formatDate utility if available and value is valid date representation
                try {
                    const date = new Date(value);
                    if (!isNaN(date.getTime())) {
                        return this.coreAPI.utils.formatDate(date.getTime());
                    }
                } catch (e) { /* Ignore formatting error */ }
                return String(value); // Fallback
            case 'list':
                return Array.isArray(value) ? value.join(', ') : String(value);
            case 'number':
            case 'text':
            case 'url':
            case 'location':
            case 'reference':
            default:
                return String(value);
        }
    }
};
