// Combined Semantic Parser Plugin (Core, Heuristic, LLM, UI concepts integrated)
"use strict";

import {Utils as utils} from './util.js';

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
    dependencies: ['ontology', 'properties', 'llm', 'richTextEditor'],

    coreAPI: null,
    ontologyService: null,
    propertiesAPI: null, // API provided by PropertiesPlugin
    llmService: null, // Optional
    editorService: null, // Optional
    _ontologyUpdateSubscription: null, // Store subscription handle

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
        // Store the unsubscribe function returned by subscribeToEvent
        const handler = this._handleOntologyUpdate.bind(this);
        const unsubscribeLoad = this.coreAPI.subscribeToEvent('ONTOLOGY_LOADED', handler);
        const unsubscribeUnload = this.coreAPI.subscribeToEvent('ONTOLOGY_UNLOADED', handler);
        // Combine unsubscribe functions
        this._ontologyUpdateSubscription = () => {
            unsubscribeLoad();
            unsubscribeUnload();
        };
    },

    // No onActivate needed for this structure, init handles dependencies.

    onDeactivate() {
        console.log("SemanticParserPlugin: Deactivating.");
        // Cancel any pending debounced parse operations
        this._debouncedParse?.cancel();
        // Unsubscribe from ontology events
        if (this._ontologyUpdateSubscription) {
            this._ontologyUpdateSubscription();
            this._ontologyUpdateSubscription = null;
        }
        // Release references
        this.coreAPI = null;
        this.ontologyService = null;
        this.propertiesAPI = null;
        this.llmService = null;
        this.editorService = null;
    },

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

            // 3. Intercept confirmation action to add property AND insert inline node
            if (action.type === 'PARSER_CONFIRM_SUGGESTION') {
                const {noteId, suggestion} = action.payload;
                const {property: propData, location} = suggestion;

                // Ensure required services are available
                if (!pluginInstance.propertiesAPI || !pluginInstance.coreAPI) {
                    console.error("Parser Middleware: Cannot confirm suggestion, Properties API or Core API unavailable.");
                    pluginInstance.coreAPI?.showGlobalStatus("Cannot confirm suggestion: Core services missing.", "error");
                    return next(action); // Let reducer update status, but skip property add/insert
                }

                const editorService = pluginInstance.coreAPI.getService('EditorService');
                const existingProp = pluginInstance._findExistingProperty(storeApi.getState, noteId, propData.key);
                let propertyIdToUse;

                // --- Perform Editor Insertion First (if possible) ---
                let editorInsertionAttempted = false;
                if (editorService && location) {
                    if (existingProp) {
                        propertyIdToUse = existingProp.id; // Use existing ID for update
                        editorService.replaceTextWithInlineProperty(location, {
                            propId: propertyIdToUse,
                            key: propData.key,
                            value: propData.value,
                            type: propData.type
                        });
                        editorInsertionAttempted = true;
                    } else {
                        propertyIdToUse = pluginInstance.coreAPI.utils.generateUUID(); // Generate ID for new property
                        editorService.replaceTextWithInlineProperty(location, {
                            propId: propertyIdToUse, // Use the newly generated ID
                            key: propData.key,
                            value: propData.value,
                            type: propData.type
                        });
                        editorInsertionAttempted = true;
                    }
                } else if (location) {
                    console.warn(`Parser Middleware: Suggestion confirmed but no EditorService found. Property will be added/updated, but text not replaced.`);
                    // Ensure propertyIdToUse is set even if editor insertion fails or isn't possible
                    if (!propertyIdToUse) {
                         propertyIdToUse = existingProp ? existingProp.id : pluginInstance.coreAPI.utils.generateUUID();
                    }
                }

                // --- Dispatch State Update (Add or Update Property) ---
                if (existingProp) {
                    // Only dispatch update if value or type actually changed
                    if (existingProp.value !== propData.value || existingProp.type !== propData.type) {
                        storeApi.dispatch({
                            type: 'PROPERTY_UPDATE',
                            payload: {
                                noteId: noteId,
                                propertyId: existingProp.id, // Use the actual existing ID
                                changes: {value: propData.value, type: propData.type} // Pass new value/type
                            }
                        });
                    } else {
                         console.log("Parser Middleware: Confirmed suggestion matches existing property value. No update dispatched.");
                    }
                } else {
                    // Dispatch PROPERTY_ADD using the ID used for editor insertion (or newly generated)
                    storeApi.dispatch({
                        type: 'PROPERTY_ADD',
                        payload: {
                            noteId: noteId,
                            temporaryId: propertyIdToUse, // Pass the ID used/generated above
                            propertyData: propData // Contains key, value, type
                        }
                    });
                }

                // Let the original PARSER_CONFIRM_SUGGESTION action proceed to the parser reducer
                // to update the suggestion's status to 'confirmed'.
                return next(action);
            }

            return result; // Return result from next(action) for other action types
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

    // --- UI Rendering (Now handled via EditorService decorations in editor.js) ---
    // registerUISlots() is removed.

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

                    // Attempt basic normalization/parsing based on type
                    if (inferredType === 'number' && !isNaN(Number(value))) {
                        structuredValue = Number(value);
                    } else if (inferredType === 'boolean') {
                        const lowerVal = String(value).toLowerCase();
                        if (['true', 'yes', '1', 'on'].includes(lowerVal)) structuredValue = true;
                        else if (['false', 'no', '0', 'off'].includes(lowerVal)) structuredValue = false;
                        else structuredValue = Boolean(value); // Fallback
                    } else if (inferredType === 'date') {
                        // Basic relative date parsing (add more robust library later)
                        const lowerVal = String(value).toLowerCase();
                        const today = new Date();
                        today.setHours(0, 0, 0, 0);
                        if (lowerVal === 'today') {
                            structuredValue = today.toISOString().split('T')[0];
                        } else if (lowerVal === 'tomorrow') {
                            const tomorrow = new Date(today);
                            tomorrow.setDate(today.getDate() + 1);
                            structuredValue = tomorrow.toISOString().split('T')[0];
                        } else if (lowerVal === 'yesterday') {
                            const yesterday = new Date(today);
                            yesterday.setDate(today.getDate() - 1);
                            structuredValue = yesterday.toISOString().split('T')[0];
                        }
                        // TODO: Add 'next week', 'last month', etc. using a date library
                        // TODO: Attempt parsing various date formats (e.g., MM/DD/YYYY)
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
    async _triggerParse(noteId, content) {
        // Ensure core services needed for *any* parsing are available
        if (!this.coreAPI || !this.ontologyService) {
            console.warn("Parser: Cannot trigger parse, CoreAPI or OntologyService unavailable.");
            return;
        }

        // Determine parsing strategy
        // Determine parsing strategy: Use LLM if service exists AND has a configured model name
        const llmService = this.coreAPI.getService('LLMService'); // Get service instance
        const llmConfig = llmService?.getCurrentConfig(); // Get config if service exists
        const useLLM = !!(llmService && llmConfig?.modelName); // Check service AND model name
        const parseFn = useLLM ? this._parseWithLLM.bind(this) : this._parseWithHeuristics.bind(this);
        const source = useLLM ? 'LLM' : 'Heuristic';

        console.log(`Parser: Triggering ${source} parse for note ${noteId} (LLM available: ${!!llmService}, LLM configured: ${!!llmConfig?.modelName})`);

        try {
            const suggestions = await parseFn(content, noteId);
            this._processSuggestions(noteId, suggestions);
        } catch (err) {
            // Catch errors from either parse function or _processSuggestions
            console.error(`Parser: Error during ${source} parsing or processing for note ${noteId}`, err);
            this.coreAPI.showGlobalStatus(`Error parsing note content (${source}): ${err.message}`, "error", 8000);
            // Clear suggestions on error to avoid showing stale/incorrect data
            this.coreAPI.dispatch({type: 'PARSER_CLEAR_SUGGESTIONS', payload: {noteId}});
        }
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
            status: s.status || 'pending',
            // Ensure location is valid for decoration if present
            location: s.location && typeof s.location.start === 'number' && typeof s.location.end === 'number' ? s.location : null
        }));
        // --- Removed filter: Don't filter out suggestions without location ---
        // We still want to store them in the state, even if they can't be decorated in the editor yet.

        // Dispatch action to update state. The editor plugin will react to this state change.
        this.coreAPI.dispatch({
            type: 'PARSER_SUGGESTIONS_RECEIVED',
            payload: {noteId, suggestions: processedSuggestions}
        });
        // No separate decoration update dispatch needed; SuggestionPlugin subscribes to state.
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
        // Check required services again within the function
        if (!content || !this.ontologyService || !this.coreAPI) {
            console.warn("Parser: Heuristic parsing skipped, content or OntologyService/CoreAPI missing.");
            return [];
        }

        const suggestions = [];
        const lines = content.split('\n');
        const ontologyRules = this.ontologyService.getRawData()?.rules || [];
        const processedIndices = new Set(); // Track indices processed by rules to avoid duplicates
        const contentLower = content.toLowerCase(); // For case-insensitive keyword matching

        // 1. Apply Ontology Rules first (more specific)
        ontologyRules.forEach(rule => {
            if (!rule.pattern || !rule.type) return; // Skip invalid rules

            try {
                // Global flag to find all matches in the content
                const regex = new RegExp(rule.pattern, rule.caseSensitive ? 'g' : 'gi');
                let match;
                while ((match = regex.exec(content)) !== null) {
                    // Check if the *entire* match range is already processed
                    let alreadyProcessed = false;
                    for (let i = match.index; i < match.index + match[0].length; i++) {
                        if (processedIndices.has(i)) {
                            alreadyProcessed = true;
                            break;
                        }
                    }
                    if (alreadyProcessed) continue;

                    const matchedValue = match[0]; // The full matched string
                    // Try to infer a key based on context (e.g., preceding words) - very basic example
                    const contextStart = Math.max(0, match.index - 40); // Increase context slightly
                    const context = content.substring(contextStart, match.index);
                    const keyMatch = context.match(/([a-zA-Z0-9\s_-]+?)\s*[:\-]\s*$/); // Look for "Key:" before match
                    const key = keyMatch ? keyMatch[1].trim() : rule.type; // Use rule type as fallback key

                    const location = {start: match.index, end: match.index + matchedValue.length};

                    // Ensure location is valid before pushing
                    if (typeof location.start === 'number' && typeof location.end === 'number') {
                        suggestions.push({
                            id: utils.generateUUID(),
                            source: 'heuristic (rule)',
                            property: {key: key, value: matchedValue, type: rule.type},
                            status: 'pending',
                            location: location,
                            confidence: 0.6 // Slightly higher confidence for explicit rules
                        });
                        // Mark indices covered by this match as processed
                        for (let i = match.index; i < match.index + matchedValue.length; i++) {
                            processedIndices.add(i);
                        }
                    } else {
                        console.warn(`Parser: Invalid location generated by heuristic rule`, {rule, match});
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
            const location = {start: wikiMatch.index, end: wikiMatch.index + wikiMatch[0].length};
            if (linkText && typeof location.start === 'number' && typeof location.end === 'number') {
                // Use a default key like 'related' or 'link' for references
                const key = 'related';
                suggestions.push({
                    id: utils.generateUUID(),
                    source: 'heuristic (wikilink)',
                    property: {key: key, value: linkText, type: 'reference'},
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
        // Improved regex to handle potential spaces around colon and capture key/value better
        const keyValueRegex = /^\s*(?<key>[a-zA-Z][a-zA-Z0-9\s_-]*?)\s*:\s*(?<value>.*)$/;
        let currentOffset = 0;
        lines.forEach((line) => {
            const lineLength = line.length + 1; // +1 for newline character
            const match = line.match(keyValueRegex);

            if (match && match.groups.key && match.groups.value) {
                const key = match.groups.key.trim();
                const value = match.groups.value.trim();
                const valueStartIndexInLine = line.indexOf(match.groups.value); // Find where the raw value starts
                const absoluteStartIndex = currentOffset + valueStartIndexInLine;
                const absoluteEndIndex = absoluteStartIndex + value.length;

                // Check if the *entire* value range overlaps with already processed indices
                let alreadyProcessed = false;
                for (let i = absoluteStartIndex; i < absoluteEndIndex; i++) {
                    if (processedIndices.has(i)) {
                        alreadyProcessed = true;
                        break;
                    }
                }

                if (value && !alreadyProcessed) {
                    const inferredType = this.ontologyService.inferType(value, key);
                    const location = {
                        start: absoluteStartIndex,
                        end: absoluteEndIndex
                    };

                    suggestions.push({
                        id: utils.generateUUID(),
                        source: 'heuristic (kv)',
                        property: {key, value, type: inferredType},
                        status: 'pending',
                        location: location,
                        confidence: 0.4 // Lower confidence for generic key-value
                    });
                    // Mark indices as processed
                    for (let i = location.start; i < location.end; i++) {
                        processedIndices.add(i);
                    }
                }
            }
            currentOffset += lineLength; // Move offset to the start of the next line
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
        // console.log(`Parser: Running LLM parsing for note ${noteId}`);
        // Check required services again within the function
        // Fix typo: llMService -> llmService
        if (!content || !this.llmService || !this.ontologyService || !this.coreAPI) {
            console.warn("Parser: LLM parsing skipped, content or LLMService/OntologyService/CoreAPI missing.");
            this.coreAPI?.showGlobalStatus("Cannot parse with AI: Services missing.", "warning");
            return [];
        }

        // --- Construct Prompt ---
        const ontologyData = this.ontologyService.getRawData(); // Assuming this doesn't throw
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

            // Call LLM Service - this might throw errors (e.g., config, network)
            // Fix typo: llMService -> llmService
            let responsePayload = await this.llmService.prompt(prompt);

            // --- Parse LLM Response ---
            if (!responsePayload?.choices?.[0]?.message?.content) {
                // Handle cases where the response structure is unexpected or content is missing
                console.warn("Parser: LLM response structure invalid or content missing.", responsePayload);
                throw new Error("LLM response was empty or malformed.");
            }
            this.coreAPI.showGlobalStatus("AI Parsing complete.", "success", 1500); // Update status only on success

            let responseText = responsePayload.choices[0].message.content;

            // Attempt to extract JSON from the response (more robustly)
            let parsedJson;
            try {
                // 1. Look for JSON within markdown code blocks
                const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
                if (jsonMatch && jsonMatch[1]) {
                    parsedJson = JSON.parse(jsonMatch[1]);
                } else {
                    // 2. If no code block, try parsing the whole response (trimmed)
                    const trimmedResponse = responseText.trim();
                    // Basic check if it looks like JSON before attempting parse
                    if ((trimmedResponse.startsWith('[') && trimmedResponse.endsWith(']')) || (trimmedResponse.startsWith('{') && trimmedResponse.endsWith('}'))) {
                        parsedJson = JSON.parse(trimmedResponse);
                    } else {
                         // 3. Handle cases where LLM might just output the JSON without brackets/braces if it's a single object (less common for arrays)
                         // This is less reliable, might need more specific LLM instructions.
                         // For now, assume array output is standard.
                         console.warn("Parser: LLM response did not contain a JSON code block or a direct JSON array/object structure.", { response: trimmedResponse });
                         throw new Error("LLM response did not contain recognizable JSON output.");
                    }
                }
            } catch (jsonError) {
                 console.error("Parser: Failed to parse JSON from LLM response.", { responseText, jsonError });
                 throw new Error(`LLM response contained invalid JSON: ${jsonError.message}`);
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
                        property: {key, value, type: inferredType},
                        status: 'pending',
                        // Assign confidence: use LLM's if provided, otherwise default (e.g., 0.8)
                        confidence: typeof item.confidence === 'number' ? Math.max(0, Math.min(1, item.confidence)) : 0.8,
                        // TODO: Location info is hard to get accurately from LLM without specific instructions/model support.
                        // Need to instruct the LLM to *also* return the exact start/end character indices of the *value* in the original text.
                        location: null // Placeholder - decorations won't work for LLM suggestions yet
                    };
                });

            console.log(`Parser: LLM found ${suggestions.length} potential suggestions.`);
            // --- Location Handling ---
            // LLM currently doesn't provide location. We return suggestions without it.
            // The SuggestionPlugin in editor.js will only create decorations for suggestions *with* location.
            // Future enhancement: Instruct LLM to return character indices.
            console.log(`Parser: LLM found ${suggestions.length} potential suggestions.`);
            return suggestions; // Return all suggestions, even without location

        } catch (error) {
            // Catch errors from LLM call or JSON parsing
            console.error("Parser: Error during LLM parsing or processing.", error);
            // Show specific error message from the caught error
            this.coreAPI.showGlobalStatus(`AI Parsing Error: ${error.message}`, "error", 8000);
            // Re-throw the error so _triggerParse can catch it and clear suggestions
            throw error;
        }
    },

    // --- Helper Methods ---

    /**
     * Handles updates to the ontology configuration.
     * Currently, it just triggers a re-parse of the selected note.
     * @private
     */
    _handleOntologyUpdate() {
        if (!this.coreAPI) return; // Check if coreAPI is still available
        console.log("ParserPlugin: Ontology updated, re-parsing selected note.");
        const selectedNote = this.coreAPI.getSelectedNote();
        if (selectedNote) {
            // Clear existing suggestions for the note before re-parsing
            this.coreAPI.dispatch({type: 'PARSER_CLEAR_SUGGESTIONS', payload: {noteId: selectedNote.id}});
            // Use the async triggerParse
            this._triggerParse(selectedNote.id, selectedNote.content).catch(err => {
                console.error("ParserPlugin: Error during re-parse after ontology update.", err);
                // Status message shown by _triggerParse's catch block
            });
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
        // Check service availability again, although middleware should have checked too
        if (!this.propertiesAPI) {
            console.warn("ParserPlugin._findExistingProperty: Properties API unavailable.");
            return null;
        }
        try {
            // We need the *current* properties, get them via the API which reads from state
            const currentProperties = this.propertiesAPI.getPropertiesForNote(noteId);
            // Ensure currentProperties is an array before calling find
            if (!Array.isArray(currentProperties)) {
                // This might happen if the note or pluginData doesn't exist yet, which is valid.
                // console.warn(`ParserPlugin._findExistingProperty: propertiesAPI.getPropertiesForNote did not return an array for note ${noteId}.`);
                return null;
            }
            // Find property matching key (case-insensitive)
            return currentProperties.find(prop => prop?.key?.toLowerCase() === key.toLowerCase()) || null;
        } catch (e) {
            console.error("ParserPlugin: Error calling propertiesAPI.getPropertiesForNote", {noteId, key, error: e});
            this.coreAPI?.showGlobalStatus("Error checking existing properties.", "error");
            return null;
        }
    }
};

