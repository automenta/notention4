// Combined Semantic Parser Plugin (Core, Heuristic, LLM, UI concepts integrated)
"use strict";

import {injectCSS, Utils as utils} from './util.js';
import { SLOT_EDITOR_BELOW_CONTENT } from './ui.js';

/**
 * Represents a suggested property extracted from note content.
 * @typedef {object} ParserSuggestion
 * @property {string} id - Unique identifier for this suggestion instance.
 * @property {string} source - Where the suggestion came from ('heuristic', 'llm').
 * @property {object} property - The suggested property data.
 * @property {string} property.key - The suggested property key.
 * @property {any} property.value - The suggested property value.
 * @property {string} [property.type] - The inferred type ('text', 'date', 'number', etc.).
 * @property {'pending' | 'confirmed' | 'ignored'} status - Current status of the suggestion.
 * @property {number} [confidence] - Optional confidence score (0-1).
 * @property {{start: number, end: number}} [location] - Optional character range in the content.
 * @property {string} [displayText] - Optional different display text for the value (e.g., relative date).
 */

export const SemanticParserPlugin = {
    id: 'parser',
    name: 'Semantic Parser',
    dependencies: ['ontology', 'properties'], // Required
    // Optional dependencies (will check for their services)
    optionalDependencies: ['llm', 'editor'],

    coreAPI: null,
    ontologyService: null,
    propertiesAPI: null, // API provided by PropertiesPlugin
    llmService: null, // Optional
    editorService: null, // Optional

    // --- Plugin Lifecycle Methods ---

    init(coreAPI) {
        this.coreAPI = coreAPI;
        // Required services
        this.ontologyService = coreAPI.getService('OntologyService');
        this.propertiesAPI = coreAPI.getPluginAPI('properties'); // Get API from Properties Plugin

        if (!this.ontologyService) {
            console.error("ParserPlugin: CRITICAL - OntologyService not available. Parsing disabled.");
            // Optionally disable the plugin entirely or parts of it
            this.activate = () => console.warn("ParserPlugin: Activation skipped due to missing OntologyService.");
            return; // Stop initialization
        }
        if (!this.propertiesAPI) {
            console.error("ParserPlugin: CRITICAL - Properties Plugin API not available. Cannot confirm suggestions.");
            this.activate = () => console.warn("ParserPlugin: Activation skipped due to missing Properties Plugin API.");
            return; // Stop initialization
        }

        // Optional services
        this.llmService = coreAPI.getService('LLMService'); // May be null
        this.editorService = coreAPI.getService('EditorService'); // May be null

        console.log(`ParserPlugin: Initialized. LLM support: ${this.llmService ? 'Enabled' : 'Disabled'}, Editor Integration: ${this.editorService ? 'Enabled' : 'Disabled'}`);

        // Subscribe to ontology changes to potentially re-parse
        this.coreAPI.subscribeToEvent('ONTOLOGY_LOADED', this._handleOntologyUpdate.bind(this));
        this.coreAPI.subscribeToEvent('ONTOLOGY_UNLOADED', this._handleOntologyUpdate.bind(this));
    },

    // No onActivate needed for this structure, init handles dependencies.

    // --- Middleware for Triggering Parsing ---

    registerMiddleware() {
        // Need 'this' context within the middleware
        const pluginInstance = this;

        return storeApi => next => action => {
            const result = next(action); // Pass action along first

            // 1. Watch for content changes to trigger parsing (debounced)
            if (action.type === 'CORE_UPDATE_NOTE' && action.payload.changes?.hasOwnProperty('content')) {
                const noteId = action.payload.noteId;
                const newContent = action.payload.changes.content;
                // Only parse if the note is currently selected for immediate feedback,
                // or implement background parsing later if needed.
                if (noteId === storeApi.getState().uiState.selectedNoteId) {
                    pluginInstance._debouncedParse(noteId, newContent);
                }
            }

            // 2. Watch for note selection to trigger parsing for the newly selected note
            //    and potentially clear suggestions for the previously selected one.
            if (action.type === 'CORE_SELECT_NOTE') {
                const newlySelectedNoteId = action.payload.noteId;
                const previousNoteId = storeApi.getState().uiState.selectedNoteId; // State *before* this action is fully processed by reducers

                // Clear suggestions for the note being deselected
                if (previousNoteId && previousNoteId !== newlySelectedNoteId) {
                    // Dispatch clearing action immediately
                    storeApi.dispatch({ type: 'PARSER_CLEAR_SUGGESTIONS', payload: { noteId: previousNoteId } });
                }

                // Trigger parsing for the newly selected note (if it exists)
                const note = storeApi.getState().notes[newlySelectedNoteId];
                if (note) {
                    // Use a shorter debounce or no debounce on selection for faster feedback
                    pluginInstance._debouncedParse.cancel(); // Cancel any pending parse from content edits
                    pluginInstance._triggerParse(newlySelectedNoteId, note.content); // Trigger immediately
                }
            }

            // 3. Intercept confirmation action if UI layer dispatches it
            // This allows adding the property *and* updating suggestion state atomically
            if (action.type === 'PARSER_CONFIRM_SUGGESTION') {
                const { noteId, suggestion } = action.payload;
                const existingProp = pluginInstance._findExistingProperty(storeApi.getState, noteId, suggestion.property.key);

                if (existingProp) {
                    // Dispatch PROPERTY_UPDATE if key already exists
                    storeApi.dispatch({
                        type: 'PROPERTY_UPDATE',
                        payload: {
                            noteId: noteId,
                            propertyId: existingProp.id,
                            changes: { value: suggestion.property.value, type: suggestion.property.type } // Update value and type
                        }
                    });
                } else {
                    // Dispatch PROPERTY_ADD if key is new
                    storeApi.dispatch({
                        type: 'PROPERTY_ADD',
                        payload: {
                            noteId: noteId,
                            propertyData: suggestion.property // Contains key, value, type
                        }
                    });
                }
                // Update the suggestion status *in the reducer* via the original action.
                // The reducer for PARSER_CONFIRM_SUGGESTION will handle this.
            }


            return result; // Return result from next(action)
        };
    },

    // --- State Management ---

    registerReducer() {
        const pluginId = this.id;

        return (draft, action) => {
            // Initialize state structure if it doesn't exist
            if (!draft.pluginRuntimeState[pluginId]) {
                draft.pluginRuntimeState[pluginId] = { suggestions: {} }; // { [noteId]: ParserSuggestion[] }
            }
            const parserState = draft.pluginRuntimeState[pluginId];

            switch (action.type) {
                case 'PARSER_SUGGESTIONS_RECEIVED': {
                    const { noteId, suggestions } = action.payload;
                    // console.log(`ParserReducer: Received ${suggestions.length} suggestions for note ${noteId}`);
                    // Replace existing suggestions for simplicity. Could merge later.
                    parserState.suggestions[noteId] = suggestions || [];
                    break;
                }
                case 'PARSER_CLEAR_SUGGESTIONS': {
                    const { noteId } = action.payload;
                    if (parserState.suggestions[noteId]) {
                        // console.log(`ParserReducer: Clearing suggestions for note ${noteId}`);
                        delete parserState.suggestions[noteId];
                    }
                    break;
                }
                case 'PARSER_CONFIRM_SUGGESTION': {
                    const { noteId, suggestion } = action.payload;
                    const noteSuggestions = parserState.suggestions[noteId];
                    if (noteSuggestions) {
                        const suggestionIndex = noteSuggestions.findIndex(s => s.id === suggestion.id);
                        if (suggestionIndex > -1) {
                            //  console.log(`ParserReducer: Marking suggestion ${suggestion.id} as confirmed for note ${noteId}`);
                            noteSuggestions[suggestionIndex].status = 'confirmed';
                            // Optionally remove confirmed suggestions from the list immediately?
                            // parserState.suggestions[noteId] = noteSuggestions.filter(s => s.status !== 'confirmed');
                        }
                    }
                    break;
                }
                case 'PARSER_IGNORE_SUGGESTION': {
                    const { noteId, suggestionId } = action.payload;
                    const noteSuggestions = parserState.suggestions[noteId];
                    if (noteSuggestions) {
                        const suggestionIndex = noteSuggestions.findIndex(s => s.id === suggestionId);
                        if (suggestionIndex > -1) {
                            //  console.log(`ParserReducer: Marking suggestion ${suggestionId} as ignored for note ${noteId}`);
                            noteSuggestions[suggestionIndex].status = 'ignored';
                            // Optionally remove ignored suggestions from the list immediately?
                            // parserState.suggestions[noteId] = noteSuggestions.filter(s => s.status !== 'ignored');
                        }
                    }
                    break;
                }

                // Clean up suggestions if a note is deleted
                case 'CORE_DELETE_NOTE': {
                    const { noteId } = action.payload;
                    if (parserState.suggestions[noteId]) {
                        //  console.log(`ParserReducer: Clearing suggestions for deleted note ${noteId}`);
                        delete parserState.suggestions[noteId];
                    }
                    break;
                }
            }
            // No return needed when mutating draft
        };
    },

    // --- UI Rendering (using SLOT_EDITOR_BELOW_CONTENT) ---

    registerUISlots() {
        // If EditorService is available, UI might be handled differently (e.g., via decorations)
        if (this.editorService) {
            console.log("ParserPlugin: EditorService detected, UI slots might be overridden or supplemented by editor decorations.");
            // TODO: Implement EditorService integration for inline highlights/popovers if available
            // this.editorService.registerDecorationProvider(...) or similar
            return {}; // Don't register the basic slot if advanced editor integration is active
        }

        // Fallback UI using SLOT_EDITOR_BELOW_CONTENT
        const pluginInstance = this; // Capture 'this' for handlers

        return {
            [SLOT_EDITOR_BELOW_CONTENT]: (props) => {
                const { state, dispatch, noteId, html } = props;
                const suggestions = state.pluginRuntimeState?.parser?.suggestions?.[noteId] || [];
                const pendingSuggestions = suggestions.filter(s => s.status === 'pending');

                if (pendingSuggestions.length === 0) {
                    return ''; // Render nothing if no pending suggestions
                }

                // --- Event Handlers for UI ---
                const handleConfirm = (suggestion) => {
                    // Dispatch action intercepted by middleware to add/update property
                    dispatch({
                        type: 'PARSER_CONFIRM_SUGGESTION',
                        payload: { noteId, suggestion }
                    });
                };

                const handleIgnore = (suggestionId) => {
                    dispatch({
                        type: 'PARSER_IGNORE_SUGGESTION',
                        payload: { noteId, suggestionId }
                    });
                };

                // --- Render Logic ---
                return html`
                    <div class="parser-suggestions-area plugin-section">
                        <h4 class="plugin-section-title">Suggestions</h4>
                        <div class="suggestions-list">
                            ${pendingSuggestions.map(s => html`
                                <div class="suggestion-item">
                                    <span class="suggestion-text">
                                        Add property: <strong class="suggestion-key">${s.property.key}</strong> = <em class="suggestion-value">${s.displayText || s.property.value}</em>?
                                        <span class="suggestion-source">(${s.source}${s.confidence ? ` ${Math.round(s.confidence * 100)}%` : ''})</span>
                                    </span>
                                    <div class="suggestion-actions">
                                        <button class="suggestion-confirm" @click=${() => handleConfirm(s)} title="Confirm">✓</button>
                                        <button class="suggestion-ignore" @click=${() => handleIgnore(s.id)} title="Ignore">✕</button>
                                     </div>
                                </div>
                            `)}
                        </div>
                    </div>
                `;
            }
        };
    },

    // --- Service Provision ---
    providesServices() {
        // Expose a service for parsing individual values if needed by other plugins
        return {
            'SemanticParserService': {
                /**
                 * Parses a single value string and attempts to infer its structured type and state.
                 * Relies on OntologyService.
                 * @param {string} value - The raw string value to parse.
                 * @param {string} [nameHint] - Optional property name to help inference.
                 * @returns {{ structuredValue: any, type: string, state: string }}
                 */
                parsePropertyValue: (value, nameHint) => {
                    if (!this.ontologyService) {
                        console.warn("SemanticParserService: Cannot parse value, OntologyService unavailable.");
                        return { structuredValue: value, type: 'text', state: 'is' }; // Fallback
                    }
                    const inferredType = this.ontologyService.inferType(value, nameHint);
                    let structuredValue = value;

                    // TODO: Add more sophisticated parsing based on inferredType and ontology rules
                    // e.g., convert "tomorrow" to actual date if type is 'date'
                    // For now, just return the inferred type
                    if (inferredType === 'number' && !isNaN(Number(value))) {
                        structuredValue = Number(value);
                    } else if (inferredType === 'boolean') {
                        structuredValue = ['true', 'yes', '1'].includes(String(value).toLowerCase());
                    }

                    return { structuredValue, type: inferredType, state: 'is' }; // 'state' seems less relevant here? Defaulting to 'is'.
                }
            }
        };
    },

    // --- Internal Parsing Logic ---

    /**
     * Debounced function to trigger parsing.
     * @type {Function}
     */
    _debouncedParse: utils.debounce(function(noteId, content) { // Use function() to bind `this` correctly if needed, or ensure arrow function context
        // `this` inside debounce refers to the SemanticParserPlugin instance
        this._triggerParse(noteId, content);
    }, 750), // Adjust debounce time as needed (e.g., 750ms)

    /**
     * Immediately triggers the parsing process.
     */
    _triggerParse(noteId, content) {
        if (!this.ontologyService) return; // Don't parse if ontology isn't ready

        // console.log(`Parser: Triggering parse for note ${noteId}`);
        // Choose parsing strategy: LLM if available and enabled, otherwise heuristic
        const parseFn = this.llmService ? this._parseWithLLM.bind(this) : this._parseWithHeuristics.bind(this);

        parseFn(content, noteId)
            .then(suggestions => {
                // Ensure suggestions have unique IDs and default status
                const processedSuggestions = suggestions.map(s => ({
                    ...s,
                    id: s.id || utils.generateUUID(),
                    status: s.status || 'pending'
                }));
                this.coreAPI.dispatch({ type: 'PARSER_SUGGESTIONS_RECEIVED', payload: { noteId, suggestions: processedSuggestions } });
            })
            .catch(err => {
                console.error("Parser: Error during parsing", { noteId, error: err });
                this.coreAPI.showGlobalStatus("Error parsing note content.", "error");
                // Clear suggestions on error?
                this.coreAPI.dispatch({ type: 'PARSER_CLEAR_SUGGESTIONS', payload: { noteId } });
            });
    },

    /**
     * Parses content using heuristic rules (regex, keywords) from OntologyService.
     * @param {string} content - The note content.
     * @param {string} noteId - The ID of the note being parsed.
     * @returns {Promise<ParserSuggestion[]>}
     * @private
     */
    async _parseWithHeuristics(content, noteId) {
        // console.log(`Parser: Running heuristic parsing for note ${noteId}`);
        if (!content || !this.ontologyService) return [];

        const suggestions = [];
        const lines = content.split('\n');
        // Example: Simple Key: Value pattern (adjust regex as needed)
        // This regex looks for a line starting with potential key chars, followed by ':', optional space, and captures the rest as value.
        const keyValueRegex = /^\s*(?<key>[a-zA-Z0-9\s_-]+?)\s*:\s*(?<value>.*)$/;

        // TODO: Integrate rules and keywords from OntologyService more deeply
        // const ontologyKeywords = this.ontologyService.getKeywords()?.tags || [];
        // const ontologyRules = this.ontologyService.getRules() || []; // Rules might define regex patterns

        lines.forEach((line, index) => {
            const match = line.match(keyValueRegex);
            if (match && match.groups.key && match.groups.value) {
                const key = match.groups.key.trim();
                const value = match.groups.value.trim();

                // Basic filtering: ignore empty values unless ontology defines it as valid?
                if (value) {
                    const inferredType = this.ontologyService.inferType(value, key);
                    const location = { // Approximate location
                        start: content.indexOf(line), // This isn't perfect if line repeats
                        end: content.indexOf(line) + line.length
                    };

                    suggestions.push({
                        id: utils.generateUUID(),
                        source: 'heuristic',
                        property: { key, value, type: inferredType },
                        status: 'pending',
                        location: location,
                    });
                }
            }
            // TODO: Add more complex heuristic rules here (e.g., matching keywords, date patterns within text)
        });

        // console.log(`Parser: Heuristics found ${suggestions.length} potential suggestions.`);
        return suggestions;
    },

    /**
     * Parses content using the LLMService.
     * @param {string} content - The note content.
     * @param {string} noteId - The ID of the note being parsed.
     * @returns {Promise<ParserSuggestion[]>}
     * @private
     */
    async _parseWithLLM(content, noteId) {
        console.log(`Parser: Running LLM parsing for note ${noteId}`);
        if (!content || !this.llmService || !this.ontologyService) return [];

        // --- Construct Prompt ---
        // Get hints from ontology about expected properties
        const hints = this.ontologyService.getHints() || {};
        const keywords = this.ontologyService.getKeywords() || {};
        let ontologyContext = "Consider the following potential property types:\n";
        for (const [key, hint] of Object.entries(hints)) {
            ontologyContext += `- ${key}: ${hint.description}\n`;
        }
        if (keywords.tags?.length) {
            ontologyContext += `\nCommon tags: ${keywords.tags.join(', ')}\n`;
        }
        if (keywords.categories?.length) {
            ontologyContext += `Common categories: ${keywords.categories.join(', ')}\n`;
        }

        const prompt = `
Analyze the following note content and extract relevant key-value properties based on common sense and the provided context.

Context about potential properties:
${ontologyContext}

Note Content:
---
${content}
---

Instructions:
1. Identify key pieces of information that can be represented as properties (key-value pairs).
2. Focus on extracting meaningful data like dates, names, locations, statuses, project names, priorities, deadlines, etc.
3. Use the context provided to guide your extraction, but also use common sense for properties not explicitly listed.
4. For dates/times, try to normalize them to YYYY-MM-DD or ISO 8601 format if possible, otherwise return the original text.
5. Ignore vague or incomplete information unless it clearly implies a property.
6. Output the results ONLY as a JSON array of objects, where each object has the structure: {"key": "...", "value": "..."}.
7. If no properties are found, output an empty JSON array: [].

JSON Output:
`;

        try {
            this.coreAPI.showGlobalStatus("Parsing with AI...", "info", 3000); // Show temp status
            const response = await this.llmService.prompt(prompt);
            this.coreAPI.showGlobalStatus("AI Parsing complete.", "success", 1500);

            // --- Parse LLM Response ---
            if (!response) throw new Error("LLM response was empty.");

            // Attempt to extract JSON from the response (might be wrapped in markdown etc.)
            const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```|(\[.*\]|\{.*\})/);
            let parsedJson;
            if (jsonMatch) {
                const jsonString = jsonMatch[1] || jsonMatch[2];
                try {
                    parsedJson = JSON.parse(jsonString);
                } catch (jsonError) {
                    console.error("Parser: Failed to parse JSON extracted from LLM response.", { jsonString, jsonError });
                    throw new Error("LLM response contained invalid JSON.");
                }
            } else {
                // Try parsing the whole response as JSON as a fallback
                try {
                    parsedJson = JSON.parse(response);
                } catch (jsonError) {
                    console.error("Parser: Failed to parse entire LLM response as JSON.", { response, jsonError });
                    throw new Error("LLM response was not valid JSON or wrapped JSON.");
                }
            }


            if (!Array.isArray(parsedJson)) {
                console.warn("Parser: LLM response was valid JSON but not an array.", parsedJson);
                return []; // Expecting an array
            }

            // Format into ParserSuggestion structure
            const suggestions = parsedJson
                .filter(item => item && typeof item.key === 'string' && item.key.trim() && item.hasOwnProperty('value')) // Basic validation
                .map(item => {
                    const key = item.key.trim();
                    const value = item.value; // Keep original value type from LLM for now
                    const inferredType = this.ontologyService.inferType(value, key);
                    return {
                        id: utils.generateUUID(),
                        source: 'llm',
                        property: { key, value, type: inferredType },
                        status: 'pending',
                        confidence: item.confidence, // If LLM provides it
                        // Location info is hard to get accurately from LLM without specific instructions
                    };
                });

            console.log(`Parser: LLM found ${suggestions.length} potential suggestions.`);
            return suggestions;

        } catch (error) {
            console.error("Parser: Error during LLM parsing or processing.", error);
            this.coreAPI.showGlobalStatus(`AI Parsing Error: ${error.message}`, "error", 5000);
            // Fallback or return empty? Returning empty for now.
            return [];
        }
    },

    // --- Helper Methods ---

    /**
     * Handles updates to the ontology configuration.
     * Currently, it just triggers a re-parse of the selected note.
     * @private
     */
    _handleOntologyUpdate() {
        console.log("ParserPlugin: Ontology updated, re-parsing selected note.");
        const selectedNote = this.coreAPI.getSelectedNote();
        if (selectedNote) {
            // Clear existing suggestions for the note before re-parsing
            this.coreAPI.dispatch({ type: 'PARSER_CLEAR_SUGGESTIONS', payload: { noteId: selectedNote.id } });
            this._triggerParse(selectedNote.id, selectedNote.content);
        }
    },

    /**
     * Finds an existing property by key for a given note using PropertiesPlugin API.
     * @param {Function} getState - Function to get the current state.
     * @param {string} noteId - The ID of the note.
     * @param {string} key - The property key to search for.
     * @returns {object | null} The existing property object or null.
     * @private
     */
    _findExistingProperty(getState, noteId, key) {
        if (!this.propertiesAPI) return null;
        try {
            // We need the *current* properties, get them via the API which reads from state
            const currentProperties = this.propertiesAPI.getPropertiesForNote(noteId);
            return currentProperties.find(prop => prop.key.toLowerCase() === key.toLowerCase()) || null;
        } catch (e) {
            console.error("ParserPlugin: Error accessing properties API", e);
            return null;
        }
    }
};

injectCSS('parser.css');