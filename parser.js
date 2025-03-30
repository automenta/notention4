// Combined Semantic Parser Plugin (Core, Heuristic, LLM, UI concepts integrated)
"use strict";

import {Utils as utils} from './util.js';
import {SLOT_EDITOR_BELOW_CONTENT} from './ui.js';

import './parser.css';

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
    dependencies: ['ontology', 'properties', 'llm', 'editor'],

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
                    storeApi.dispatch({type: 'PARSER_CLEAR_SUGGESTIONS', payload: {noteId: previousNoteId}});
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
                const {noteId, suggestion} = action.payload;
                const existingProp = pluginInstance._findExistingProperty(storeApi.getState, noteId, suggestion.property.key);

                if (existingProp) {
                    // Dispatch PROPERTY_UPDATE if key already exists
                    storeApi.dispatch({
                        type: 'PROPERTY_UPDATE',
                        payload: {
                            noteId: noteId,
                            propertyId: existingProp.id,
                            changes: {value: suggestion.property.value, type: suggestion.property.type} // Update value and type
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
                draft.pluginRuntimeState[pluginId] = {suggestions: {}}; // { [noteId]: ParserSuggestion[] }
            }
            const parserState = draft.pluginRuntimeState[pluginId];

            switch (action.type) {
                case 'PARSER_SUGGESTIONS_RECEIVED': {
                    const {noteId, suggestions} = action.payload;
                    // console.log(`ParserReducer: Received ${suggestions.length} suggestions for note ${noteId}`);
                    // Replace existing suggestions for simplicity. Could merge later.
                    parserState.suggestions[noteId] = suggestions || [];
                    break;
                }
                case 'PARSER_CLEAR_SUGGESTIONS': {
                    const {noteId} = action.payload;
                    if (parserState.suggestions[noteId]) {
                        // console.log(`ParserReducer: Clearing suggestions for note ${noteId}`);
                        delete parserState.suggestions[noteId];
                    }
                    break;
                }
                case 'PARSER_CONFIRM_SUGGESTION': {
                    const {noteId, suggestion} = action.payload;
                    const noteSuggestions = parserState.suggestions[noteId];
                    if (noteSuggestions) {
                        const suggestionIndex = noteSuggestions.findIndex(s => s.id === suggestion.id);
                        if (suggestionIndex > -1) {
                            // console.log(`ParserReducer: Marking suggestion ${suggestion.id} as confirmed for note ${noteId}`);
                            // Update the status directly on the suggestion object in the state
                            noteSuggestions[suggestionIndex].status = 'confirmed';
                        } else {
                            console.warn(`ParserReducer: Suggestion ${suggestion.id} not found for confirmation in note ${noteId}`);
                        }
                    }
                    break;
                }
                case 'PARSER_IGNORE_SUGGESTION': {
                    const {noteId, suggestionId} = action.payload;
                    const noteSuggestions = parserState.suggestions[noteId];
                    if (noteSuggestions) {
                        const suggestionIndex = noteSuggestions.findIndex(s => s.id === suggestionId);
                        if (suggestionIndex > -1) {
                            // console.log(`ParserReducer: Marking suggestion ${suggestionId} as ignored for note ${noteId}`);
                            // Update the status directly on the suggestion object in the state
                            noteSuggestions[suggestionIndex].status = 'ignored';
                        } else {
                            console.warn(`ParserReducer: Suggestion ${suggestionId} not found for ignoring in note ${noteId}`);
                        }
                    }
                    break;
                }

                // Clean up suggestions if a note is deleted
                case 'CORE_DELETE_NOTE': {
                    const {noteId} = action.payload;
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
                const {state, dispatch, noteId, html} = props;
                const allSuggestions = state.pluginRuntimeState?.parser?.suggestions?.[noteId] || [];
                const pendingSuggestions = allSuggestions.filter(s => s.status === 'pending');
                const handledSuggestions = allSuggestions.filter(s => s.status === 'confirmed' || s.status === 'ignored');

                if (pendingSuggestions.length === 0 && handledSuggestions.length === 0) {
                    return ''; // Render nothing if no suggestions at all
                }

                // --- Event Handlers for UI (Only needed for pending suggestions) ---
                const handleConfirm = (suggestion) => {
                    // Dispatch action intercepted by middleware to add/update property
                    dispatch({
                        type: 'PARSER_CONFIRM_SUGGESTION',
                        payload: {noteId, suggestion}
                    });
                };

                const handleIgnore = (suggestionId) => {
                    dispatch({
                        type: 'PARSER_IGNORE_SUGGESTION',
                        payload: {noteId, suggestionId}
                    });
                };

                // --- Render Logic ---
                const renderSuggestion = (s, isPending) => html`
                    <div class="suggestion-item ${s.status}">
                        <span class="suggestion-text">
                            ${isPending ? 'Add property:' : (s.status === 'confirmed' ? '✓ Added:' : '✕ Ignored:')}
                            <strong class="suggestion-key">${s.property.key}</strong> = <em class="suggestion-value">${s.displayText || s.property.value}</em>
                            <span class="suggestion-source" title="Source: ${s.source}${s.confidence ? ` | Confidence: ${Math.round(s.confidence * 100)}%` : ''}">
                                (${s.source.replace('heuristic ', 'H:')}${s.confidence ? ` ${Math.round(s.confidence * 100)}%` : ''})
                            </span>
                        </span>
                        ${isPending ? html`
                            <div class="suggestion-actions">
                                <button class="suggestion-confirm" @click=${() => handleConfirm(s)} title="Confirm">✓</button>
                                <button class="suggestion-ignore" @click=${() => handleIgnore(s.id)} title="Ignore">✕</button>
                            </div>
                        ` : ''}
                    </div>
                `;

                return html`
                    <div class="parser-suggestions-area plugin-section">
                        ${pendingSuggestions.length > 0 ? html`
                            <h4 class="plugin-section-title">Suggestions</h4>
                            <div class="suggestions-list pending">
                                ${pendingSuggestions.map(s => renderSuggestion(s, true))}
                            </div>
                        ` : ''}

                        ${handledSuggestions.length > 0 ? html`
                            <details class="handled-suggestions-section">
                                <summary class="plugin-section-title handled-title">
                                    Handled Suggestions (${handledSuggestions.length})
                                </summary>
                                <div class="suggestions-list handled">
                                    ${handledSuggestions.map(s => renderSuggestion(s, false))}
                                </div>
                            </details>
                        ` : ''}
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
                        return {structuredValue: value, type: 'text', state: 'is'}; // Fallback
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

                    return {structuredValue, type: inferredType, state: 'is'}; // 'state' seems less relevant here? Defaulting to 'is'.
                }
            }
        };
    },

    // --- Internal Parsing Logic ---

    /**
     * Debounced function to trigger parsing.
     * @type {Function}
     */
    _debouncedParse: utils.debounce(function (noteId, content) { // Use function() to bind `this` correctly if needed, or ensure arrow function context
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
            .then(suggestions => this._processSuggestions(noteId, suggestions))
            .catch(err => {
                console.error("Parser: Error during parsing", {noteId, error: err});
                this.coreAPI.showGlobalStatus("Error parsing note content.", "error");
                // Clear suggestions on error?
                this.coreAPI.dispatch({type: 'PARSER_CLEAR_SUGGESTIONS', payload: {noteId}});
            });
    },

    /**
     * Processes and dispatches suggestions, ensuring unique IDs and default status.
     * @param {string} noteId - The ID of the note.
     * @param {ParserSuggestion[]} suggestions - Array of suggestion objects.
     * @private
     */
    _processSuggestions(noteId, suggestions) {
        // Ensure suggestions have unique IDs and default status
        const processedSuggestions = suggestions.map(s => ({
            ...s,
            id: s.id || utils.generateUUID(),
            status: s.status || 'pending'
        }));
        this.coreAPI.dispatch({
            type: 'PARSER_SUGGESTIONS_RECEIVED',
            payload: {noteId, suggestions: processedSuggestions}
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
        const ontologyRules = this.ontologyService.getRawData()?.rules || [];
        const processedIndices = new Set(); // Track indices processed by rules to avoid duplicates

        // 1. Apply Ontology Rules first (more specific)
        ontologyRules.forEach(rule => {
            if (!rule.pattern || !rule.type) return; // Skip invalid rules

            try {
                // Global flag to find all matches in the content
                const regex = new RegExp(rule.pattern, rule.caseSensitive ? 'g' : 'gi');
                let match;
                while ((match = regex.exec(content)) !== null) {
                    // Avoid processing the same match index multiple times if rules overlap
                    if (processedIndices.has(match.index)) continue;

                    const matchedValue = match[0]; // The full matched string
                    // Try to infer a key based on context (e.g., preceding words) - very basic example
                    const contextStart = Math.max(0, match.index - 30);
                    const context = content.substring(contextStart, match.index);
                    const keyMatch = context.match(/([a-zA-Z0-9\s_-]+?)\s*[:\-]\s*$/); // Look for "Key:" before match
                    const key = keyMatch ? keyMatch[1].trim() : rule.type; // Use rule type as fallback key

                    const location = { start: match.index, end: match.index + matchedValue.length };

                    suggestions.push({
                        id: utils.generateUUID(),
                        source: 'heuristic (rule)',
                        property: { key: key, value: matchedValue, type: rule.type },
                        status: 'pending',
                        location: location,
                        confidence: 0.6 // Slightly higher confidence for explicit rules
                    });
                    // Mark indices covered by this match as processed
                    for (let i = match.index; i < match.index + matchedValue.length; i++) {
                        processedIndices.add(i);
                    }
                }
            } catch (e) {
                console.warn(`Parser: Error applying heuristic rule regex: ${rule.pattern}`, e);
            }
        });


        // 2. Apply Wiki-style Link pattern [[Note Name]]
        const wikiLinkRegex = /\[\[(?<linkText>[^\]]+)\]\]/g;
        let wikiMatch;
        while ((wikiMatch = wikiLinkRegex.exec(content)) !== null) {
            if (processedIndices.has(wikiMatch.index)) continue; // Skip if already processed

            const linkText = wikiMatch.groups.linkText.trim();
            if (linkText) {
                const location = { start: wikiMatch.index, end: wikiMatch.index + wikiMatch[0].length };
                // Use a default key like 'related' or 'link' for references
                const key = 'related';
                suggestions.push({
                    id: utils.generateUUID(),
                    source: 'heuristic (wikilink)',
                    property: { key: key, value: linkText, type: 'reference' },
                    status: 'pending',
                    location: location,
                    confidence: 0.7 // Reasonably confident about the intent
                });
                // Mark indices as processed
                for (let i = location.start; i < location.end; i++) {
                    processedIndices.add(i);
                }
            }
        }


        // 3. Apply Simple Key: Value pattern (less specific, avoid processed indices)
        const keyValueRegex = /^\s*(?<key>[a-zA-Z0-9\s_-]+?)\s*:\s*(?<value>.*)$/;
        lines.forEach((line, lineIndex) => {
            // Find start index (approximate if line repeats). Need a more robust way if lines repeat often.
            // This simple indexOf might pick the wrong line if identical lines exist.
            // A more complex approach would involve tracking line numbers and offsets.
            let lineStartOffset = -1;
            let searchFromIndex = 0;
            while (lineStartOffset === -1 && searchFromIndex < content.length) {
                const potentialOffset = content.indexOf(line, searchFromIndex);
                if (potentialOffset === -1) break; // Line not found
                // Basic check: ensure this offset hasn't been fully processed already
                let isProcessed = true;
                for(let i = 0; i < line.length; i++) {
                    if (!processedIndices.has(potentialOffset + i)) {
                        isProcessed = false;
                        break;
                    }
                }
                if (!isProcessed) {
                    lineStartOffset = potentialOffset;
                }
                searchFromIndex = potentialOffset + 1; // Start next search after this potential match
            }
            if (lineStartOffset === -1) return; // Skip if line couldn't be reliably located or was fully processed
            const match = line.match(keyValueRegex);

            if (match && match.groups.key && match.groups.value) {
                const key = match.groups.key.trim();
                const value = match.groups.value.trim();
                const valueStartIndex = line.indexOf(value); // Index within the line
                const absoluteStartIndex = lineStartOffset + valueStartIndex;

                // Check if the start of the value has already been processed by a rule
                if (value && !processedIndices.has(absoluteStartIndex)) {
                    const inferredType = this.ontologyService.inferType(value, key);
                    const location = {
                        start: absoluteStartIndex,
                        end: absoluteStartIndex + value.length
                    };

                    suggestions.push({
                        id: utils.generateUUID(),
                        source: 'heuristic (kv)',
                        property: { key, value, type: inferredType },
                        status: 'pending',
                        location: location,
                        confidence: 0.4 // Lower confidence for generic key-value
                    });
                }
            }
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
        const ontologyData = this.ontologyService.getRawData();
        let ontologyContext = "Ontology Context:\n";
        ontologyContext += "Defined Properties (Key: Type - Description):\n";
        if (ontologyData?.properties) {
            for (const [key, propDef] of Object.entries(ontologyData.properties)) {
                ontologyContext += `- ${key}: ${propDef.type || 'text'} - ${propDef.description || 'No description'}\n`;
                if (propDef.validation?.allowedValues) {
                    ontologyContext += `    (Allowed values: ${propDef.validation.allowedValues.join(', ')})\n`;
                }
            }
        } else {
            ontologyContext += "- None defined.\n";
        }
        ontologyContext += "\nCommon Keywords/Tags:\n";
        if (ontologyData?.keywords?.tags?.length) {
            ontologyContext += `- Tags: ${ontologyData.keywords.tags.join(', ')}\n`;
        }
        if (ontologyData?.keywords?.categories?.length) {
            ontologyContext += `- Categories: ${ontologyData.keywords.categories.join(', ')}\n`;
        }
        if (!ontologyData?.keywords?.tags?.length && !ontologyData?.keywords?.categories?.length) {
            ontologyContext += "- None defined.\n";
        }

        const prompt = `
Analyze the following note content and extract relevant key-value properties based on common sense and the provided ontology context.

${ontologyContext}

Note Content:
---
${content}
---

Instructions:
1. Identify key pieces of information that can be represented as properties (key-value pairs).
2. Focus on extracting meaningful data like dates, names, locations, statuses, project names, priorities, deadlines, etc.
3. Use the property definitions from the ontology context to guide your extraction (match keys and expected types). Also use common sense for properties not explicitly listed.
4. **Value Normalization**:
    - Dates/Times: Normalize to ISO 8601 format (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ssZ) whenever possible. If ambiguous, return the original text.
    - Numbers: Output as numeric types in JSON.
    - Booleans: Output as true/false in JSON.
    - Lists/Tags: If a property type is 'list' (like 'tags'), try to extract multiple items into a JSON array of strings.
5. Ignore vague or incomplete information unless it clearly implies a property.
6. Output the results ONLY as a JSON array of objects. Each object MUST have the structure: {"key": "...", "value": ...}. You MAY optionally include a "confidence": float (0.0-1.0) field if you are unsure.
7. If no properties are found, output an empty JSON array: [].

JSON Output:
`;

        try {
            this.coreAPI.showGlobalStatus("Parsing with AI...", "info", 3000); // Show temp status
            let response = await this.llmService.prompt(prompt);
            this.coreAPI.showGlobalStatus("AI Parsing complete.", "success", 1500);

            // --- Parse LLM Response ---
            if (!response) throw new Error("LLM response was empty.");

            response = response.choices[0].message.content;

            // Attempt to extract JSON from the response (might be wrapped in markdown etc.)
            const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```|(\[.*\]|\{.*\})/);
            let parsedJson;
            if (jsonMatch) {
                const jsonString = jsonMatch[1] || jsonMatch[2];
                try {
                    parsedJson = JSON.parse(jsonString);
                } catch (jsonError) {
                    console.error("Parser: Failed to parse JSON extracted from LLM response.", {jsonString, jsonError});
                    throw new Error("LLM response contained invalid JSON.");
                }
            } else {
                // Try parsing the whole response as JSON as a fallback
                try {
                    parsedJson = JSON.parse(response);
                } catch (jsonError) {
                    console.error("Parser: Failed to parse entire LLM response as JSON.", {response, jsonError});
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
                        // Assign confidence: use LLM's if provided, otherwise default (e.g., 0.8)
                        confidence: typeof item.confidence === 'number' ? Math.max(0, Math.min(1, item.confidence)) : 0.8,
                        // Location info is hard to get accurately from LLM without specific instructions/model support
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
            this.coreAPI.dispatch({type: 'PARSER_CLEAR_SUGGESTIONS', payload: {noteId: selectedNote.id}});
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

